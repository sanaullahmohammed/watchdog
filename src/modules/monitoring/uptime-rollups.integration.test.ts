import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { recordCheckResultCommand } from '@/modules/monitoring/commands/record-check-result/record-check-result.handler';
import {
  type RefreshUptimeRollupsCommandResult,
  refreshUptimeRollupsCommand,
} from '@/modules/monitoring/commands/refresh-uptime-rollups/refresh-uptime-rollups.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { capturing } from '@/shared/testing/events';
import {
  createCheckResultPartitions,
  createMonitor,
  createService,
  insertCheckResult,
  setRollupProgress,
  utcToday,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import { runWorkerPass } from '@/worker';
import uptimeRollupRepository from './database/uptime-rollup.repository';

/**
 * Story 5.11: daily uptime rollups. Runs scoped passes only, and arranges its
 * days relative to the database's UTC today ("d-n" is n days before it).
 * Dates stay within the last 10 months, which the partitions suite leaves to
 * other files.
 */

const tag = `upr-${randomBytes(4).toString('hex')}`;
const DAY = 86_400_000;

let app: FastifyInstance;
let today: Date;
let counter = 0;

type Tenant = {
  cookie: string;
  orgId: string;
  serviceId: string;
  monitorId: string;
};

/** UTC midnight of d-n, plus an optional time of day. */
const at = (n: number, h = 0, m = 0, s = 0, ms = 0) =>
  new Date(today.getTime() - n * DAY + ((h * 60 + m) * 60 + s) * 1000 + ms);
const dayText = (n: number) => at(n).toISOString().slice(0, 10);

async function newTenant(): Promise<Tenant> {
  counter += 1;
  const { cookie, orgId } = await signUpWithOrg(app, `${tag}-${counter}`);
  const serviceId = await createService(app, cookie);
  const monitorId = await createMonitor(app, cookie, serviceId);
  return { cookie, orgId, serviceId, monitorId };
}

const result = (
  t: Tenant,
  checkedAt: Date,
  status: 'success' | 'failure',
  latencyMs: number | null = status === 'success' ? 100 : null,
) =>
  insertCheckResult(t.orgId, {
    monitorId: t.monitorId,
    serviceId: t.serviceId,
    checkedAt,
    status,
    latencyMs,
  });

const refresh = (orgId: string) =>
  app.commandBus.execute<RefreshUptimeRollupsCommandResult>(
    refreshUptimeRollupsCommand({ orgId }),
  );

type Rollup = {
  day: string;
  total_checks: number;
  successful_checks: number;
  failed_checks: number;
  uptime_ratio: string;
  avg_latency_ms: string | null;
  worst_status: string;
  updated_at: Date;
  xmin: string;
};

const rollups = (orgId: string) =>
  withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<Rollup[]>`
        select day::text as day, total_checks, successful_checks,
          failed_checks, uptime_ratio::text, avg_latency_ms::text,
          worst_status, updated_at, xmin::text
        from uptime_rollups order by day, service_id
      `,
  );

const progress = (orgId: string) =>
  withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<
      { day: string; updated_at: Date; xmin: string }[]
    >`select refreshed_through::text as day, updated_at, xmin::text from uptime_rollup_progress`;
    return rows[0] ?? null;
  });

const days = async (orgId: string) => (await rollups(orgId)).map((r) => r.day);

const silent = { info() {}, warn() {}, error() {} } as never;

describe('Story 5.11: uptime rollups', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    today = await utcToday();
  });

  after(async () => {
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('enables and forces RLS on both tables', async () => {
    const rows = await sql<{ relname: string; on: boolean; forced: boolean }[]>`
      select relname::text, relrowsecurity as on, relforcerowsecurity as forced
      from pg_class
      where relname in ('uptime_rollups', 'uptime_rollup_progress')
    `;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.on && row.forced, true, row.relname);
    }
  });

  it('refuses a worst_status outside the three-level scale', async () => {
    const t = await newTenant();
    await assert.rejects(
      withTenantTransaction(
        t.orgId,
        ({ sql: tx }) =>
          tx`
          insert into uptime_rollups (
            org_id, service_id, day, total_checks, successful_checks,
            failed_checks, uptime_ratio, worst_status
          ) values (${t.orgId}, ${t.serviceId}, ${dayText(1)}, 1, 1, 0, 1, 'minor')
        `,
      ),
      (error: { code?: string }) => error.code === '23514',
    );
  });

  it('aggregates a day', async () => {
    const t = await newTenant();
    for (const ms of [100, 200, 300]) {
      await result(t, at(1, 10, 0, ms / 100), 'success', ms);
    }
    await result(t, at(1, 11), 'failure');
    await refresh(t.orgId);
    const [row] = await rollups(t.orgId);
    assert.equal(row.day, dayText(1));
    assert.equal(row.total_checks, 4);
    assert.equal(row.successful_checks, 3);
    assert.equal(row.failed_checks, 1);
    assert.equal(Number(row.uptime_ratio), 0.75);
    assert.equal(Number(row.avg_latency_ms), 200);
    assert.equal(row.worst_status, 'degraded');
  });

  it('climbs the ladder by failure count', async () => {
    const t = await newTenant();
    await result(t, at(3, 1), 'success');
    await result(t, at(2, 1), 'failure');
    await result(t, at(1, 1), 'failure', null);
    await refresh(t.orgId);
    const byDay = new Map((await rollups(t.orgId)).map((r) => [r.day, r]));
    assert.equal(byDay.get(dayText(3))?.worst_status, 'operational');
    assert.equal(byDay.get(dayText(2))?.worst_status, 'major_outage');
    assert.equal(byDay.get(dayText(2))?.avg_latency_ms, null);
    assert.equal(byDay.get(dayText(1))?.avg_latency_ms, null);
  });

  it('writes no row for a day without results', async () => {
    const t = await newTenant();
    await result(t, at(3, 5), 'success');
    await result(t, at(1, 5), 'success');
    await refresh(t.orgId);
    assert.deepEqual(await days(t.orgId), [dayText(3), dayText(1)]);
  });

  it('leaves rows and progress alone when nothing changed, and emits nothing', async () => {
    const t = await newTenant();
    await result(t, at(2, 5), 'success');
    await result(t, at(1, 5), 'failure');
    const first = await capturing(app, 'uptime/rollup_refreshed', () =>
      refresh(t.orgId),
    );
    await app.eventBus.drain();
    const before = { rows: await rollups(t.orgId), p: await progress(t.orgId) };
    const second = await capturing(app, 'uptime/rollup_refreshed', () =>
      refresh(t.orgId),
    );
    await app.eventBus.drain();
    assert.equal(first.captured.length, 1);
    assert.equal(second.captured.length, 0);
    assert.deepEqual(await rollups(t.orgId), before.rows);
    assert.deepEqual(await progress(t.orgId), before.p);
  });

  it('counts a late result in the day it was checked', async () => {
    const t = await newTenant();
    await setRollupProgress(t.orgId, at(1));
    await result(t, at(1, 12), 'success');
    await refresh(t.orgId);
    await result(t, at(1, 23, 59, 59, 900), 'failure');
    await refresh(t.orgId);
    const rows = await rollups(t.orgId);
    assert.deepEqual(
      rows.map((r) => [r.day, r.total_checks]),
      [[dayText(1), 2]],
    );
  });

  it('groups by UTC day whatever the session time zone', async () => {
    const t = await newTenant();
    await result(t, at(1, 23, 30), 'success');
    await result(t, at(0, 0, 30), 'success');
    const repo = uptimeRollupRepository();
    await withTenantTransaction(t.orgId, async (tx) => {
      await tx.sql`set local time zone 'Pacific/Kiritimati'`;
      await repo.refresh(tx, t.orgId, dayText(1), dayText(0));
    });
    assert.deepEqual(
      (await rollups(t.orgId)).map((r) => [r.day, r.total_checks]),
      [
        [dayText(1), 1],
        [dayText(0), 1],
      ],
    );
  });

  it('catches up the closed days after the watermark', async () => {
    const t = await newTenant();
    await setRollupProgress(t.orgId, at(6));
    for (const n of [5, 4, 2]) await result(t, at(n, 3), 'success');
    await refresh(t.orgId);
    assert.deepEqual(await days(t.orgId), [dayText(5), dayText(4), dayText(2)]);
    assert.equal((await progress(t.orgId))?.day, dayText(1));
  });

  it('starts at the oldest result with no progress and writes the watermark', async () => {
    const t = await newTenant();
    await result(t, at(7, 3), 'success');
    await result(t, at(1, 3), 'success');
    await refresh(t.orgId);
    assert.deepEqual(await days(t.orgId), [dayText(7), dayText(1)]);
    assert.equal((await progress(t.orgId))?.day, dayText(1));
  });

  it('writes the watermark as yesterday for an organization with no results', async () => {
    const t = await newTenant();
    assert.equal(await refresh(t.orgId), null);
    assert.equal((await progress(t.orgId))?.day, dayText(1));
    assert.deepEqual(await days(t.orgId), []);
  });

  it('reports a range retention dropped and writes nothing for it', async () => {
    const t = await newTenant();
    const old = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 18, 15),
    );
    await setRollupProgress(t.orgId, old);
    const lost = await refresh(t.orgId);
    assert.ok(lost);
    assert.equal(
      lost.from,
      new Date(old.getTime() + DAY).toISOString().slice(0, 10),
    );
    const monthStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10);
    assert.ok(lost.to < monthStart);
    assert.ok(lost.to >= lost.from);
    assert.ok((await days(t.orgId)).every((d) => d > lost.to));
    assert.equal((await progress(t.orgId))?.day, dayText(1));
    assert.equal(await refresh(t.orgId), null);
  });

  it('refreshes yesterday when the watermark is ahead of it', async () => {
    const t = await newTenant();
    await setRollupProgress(t.orgId, at(-2));
    await result(t, at(1, 3), 'success');
    await refresh(t.orgId);
    assert.deepEqual(await days(t.orgId), [dayText(1)]);
    assert.equal((await progress(t.orgId))?.day, dayText(-2));
  });

  it('writes one row per service for the same day', async () => {
    const t = await newTenant();
    const secondService = await createService(app, t.cookie);
    const secondMonitor = await createMonitor(app, t.cookie, secondService);
    await result(t, at(1, 3), 'success');
    await insertCheckResult(t.orgId, {
      monitorId: secondMonitor,
      serviceId: secondService,
      checkedAt: at(1, 4),
      status: 'failure',
    });
    await refresh(t.orgId);
    const rows = await withTenantTransaction(
      t.orgId,
      ({ sql: tx }) =>
        tx<
          { service_id: string; worst_status: string }[]
        >`select service_id, worst_status from uptime_rollups where day = ${dayText(1)}::date`,
    );
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((r) => r.service_id === t.serviceId)?.worst_status,
      'operational',
    );
    assert.equal(
      rows.find((r) => r.service_id === secondService)?.worst_status,
      'major_outage',
    );
  });

  it('averages successful latency only', async () => {
    const t = await newTenant();
    await result(t, at(1, 3), 'success', 100);
    await result(t, at(1, 4), 'success', 300);
    await result(t, at(1, 5), 'failure', 5000);
    await refresh(t.orgId);
    const [row] = await rollups(t.orgId);
    assert.equal(Number(row.avg_latency_ms), 200);
  });

  describe('in the worker pass', () => {
    type Repo = {
      createPartitions: (...a: unknown[]) => Promise<number>;
      dropExpired: (...a: unknown[]) => Promise<number>;
    };
    const stubbed = async (
      dropExpired: Repo['dropExpired'],
      run: () => Promise<void>,
    ) => {
      const repo = app.diContainer.resolve(
        'checkResultPartitionRepository' as never,
      ) as Repo;
      const original = { ...repo };
      repo.createPartitions = async () => 0;
      repo.dropExpired = dropExpired;
      try {
        await run();
      } finally {
        Object.assign(repo, original);
      }
    };

    it('rolls a day up before partition maintenance runs', async () => {
      const t = await newTenant();
      await result(t, at(3, 4), 'success');
      let seen: string[] | null = null;
      await stubbed(
        async () => {
          seen = await days(t.orgId);
          return 0;
        },
        () =>
          runWorkerPass(app, silent, {
            orgIds: [t.orgId],
            maintainPartitions: true,
          }),
      );
      assert.deepEqual(seen, [dayText(3)]);
    });

    it('logs a lost range once, as a warning with the organization', async () => {
      const t = await newTenant();
      const old = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 18, 15),
      );
      await setRollupProgress(t.orgId, old);
      const warnings: Record<string, unknown>[] = [];
      await runWorkerPass(
        app,
        {
          info() {},
          error() {},
          warn: (obj: Record<string, unknown>) => warnings.push(obj),
        } as never,
        { orgIds: [t.orgId] },
      );
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].orgId, t.orgId);
      assert.equal(typeof warnings[0].from, 'string');
      assert.equal(typeof warnings[0].to, 'string');
    });
  });

  it('keeps one organization out of the other', async () => {
    const a = await newTenant();
    const b = await newTenant();
    await result(a, at(1, 3), 'success');
    await result(b, at(1, 3), 'failure');
    await refresh(a.orgId);
    assert.equal((await rollups(a.orgId)).length, 1);
    assert.equal((await rollups(a.orgId))[0].worst_status, 'operational');
    assert.equal((await rollups(b.orgId)).length, 0);
    await refresh(b.orgId);
    assert.equal((await rollups(b.orgId))[0].worst_status, 'major_outage');
  });

  it('counts a warned certificate by its outcome alone', async () => {
    counter += 1;
    const own = await signUpWithOrg(app, `${tag}-${counter}`);
    const serviceId = await createService(app, own.cookie);
    const monitorId = await createMonitor(app, own.cookie, serviceId, {
      type: 'ssl_expiry',
      target: '203.0.113.10',
      config: { warnDays: 14 },
    });
    // Derived from the database's today, so the pair cannot straddle midnight.
    const checkedAt = at(1, 12);
    await createCheckResultPartitions(checkedAt);
    const expiry = (ms: number) =>
      new Date(checkedAt.getTime() + ms).toISOString();
    await app.commandBus.execute(
      recordCheckResultCommand({
        orgId: own.orgId,
        monitorId,
        outcome: {
          status: 'success',
          checkedAt,
          latencyMs: 10,
          errorCode: null,
          errorMessage: null,
          metadata: {
            certificateFingerprint: 'AA:01',
            certificateExpiresAt: expiry(5 * DAY),
            daysRemaining: 5,
          },
        },
      }),
    );
    await app.commandBus.execute(
      recordCheckResultCommand({
        orgId: own.orgId,
        monitorId,
        outcome: {
          status: 'failure',
          checkedAt: new Date(checkedAt.getTime() + 1),
          latencyMs: null,
          errorCode: 'certificate_expired',
          errorMessage: 'expired',
          metadata: {
            certificateFingerprint: 'BB:02',
            certificateExpiresAt: expiry(-DAY),
            daysRemaining: null,
          },
        },
      }),
    );
    const markers = await withTenantTransaction(
      own.orgId,
      ({ sql: tx }) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from monitor_ssl_warnings`,
    );
    assert.equal(markers[0].n, 2);
    await refresh(own.orgId);
    const rows = await rollups(own.orgId);
    // Both results fall on d-1, so there is one row.
    const sum = (key: 'total_checks' | 'successful_checks' | 'failed_checks') =>
      rows.reduce((acc, r) => acc + r[key], 0);
    assert.equal(sum('total_checks'), 2);
    assert.equal(sum('successful_checks'), 1);
    assert.equal(sum('failed_checks'), 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].worst_status, 'degraded');
  });

  it('prunes old rollups and announces it', async () => {
    const t = await newTenant();
    const keep = env.monitor.rollupRetentionDays;
    const inside = Math.max(keep - 1, 0);
    await setRollupProgress(t.orgId, at(1));
    await withTenantTransaction(t.orgId, async ({ sql: tx }) => {
      for (const n of [keep + 1, keep, inside]) {
        await tx`
          insert into uptime_rollups (
            org_id, service_id, day, total_checks, successful_checks,
            failed_checks, uptime_ratio, worst_status
          ) values (${t.orgId}, ${t.serviceId}, ${dayText(n)}, 1, 1, 0, 1, 'operational')
        `;
      }
    });
    const { captured } = await capturing(app, 'uptime/rollup_refreshed', () =>
      refresh(t.orgId),
    );
    await app.eventBus.drain();
    assert.deepEqual(await days(t.orgId), [dayText(keep), dayText(inside)]);
    const mine = captured.filter(
      (e) => (e as { payload: { orgId: string } }).payload.orgId === t.orgId,
    );
    assert.deepEqual(
      mine.map((e) => (e as { payload: unknown }).payload),
      [
        {
          orgId: t.orgId,
          from: dayText(1),
          through: dayText(0),
          written: 0,
          pruned: 1,
        },
      ],
    );
  });
});
