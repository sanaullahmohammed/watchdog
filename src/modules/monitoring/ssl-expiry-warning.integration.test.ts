import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  type RecordCheckResultCommandResult,
  recordCheckResultCommand,
} from '@/modules/monitoring/commands/record-check-result/record-check-result.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as events from '@/shared/events/monitor.events';
import {
  createCheckResultPartitions,
  createMonitor,
  createService,
  setMonitorCheckState,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import type {
  CheckErrorCode,
  CheckOutcome,
  SslExpiryCheckMetadata,
} from './checks/check-outcome';

/**
 * Story 5.7: warn once per certificate before it expires.
 * Runs no worker pass and never orders rows by time (AGENTS.md clock skew).
 */

const tag = `ssw-${randomBytes(4).toString('hex')}`;
const DAY = 86_400_000;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let otherUserId = '';
let otherOrgId = '';
let orgId = '';
let serviceId = '';
const base = new Date();
let tick = 0;

type Emitted = { type: string; payload: Record<string, unknown> };
const emitted: Emitted[] = [];

const nextTime = () => new Date(base.getTime() + tick++);

type Meta = SslExpiryCheckMetadata;

function outcome(
  fingerprint: string | null,
  expiresInMs: number | null,
  opts: { status?: 'success' | 'failure'; code?: CheckErrorCode } = {},
  checkedAt = nextTime(),
): CheckOutcome<Meta> {
  const metadata: Meta = {
    certificateFingerprint: fingerprint,
    certificateExpiresAt:
      expiresInMs === null
        ? null
        : new Date(checkedAt.getTime() + expiresInMs).toISOString(),
    daysRemaining: null,
  };
  if (opts.status === 'failure') {
    return {
      status: 'failure',
      checkedAt,
      latencyMs: null,
      errorCode: opts.code ?? 'connection_refused',
      errorMessage: 'failed',
      metadata,
    };
  }
  return {
    status: 'success',
    checkedAt,
    latencyMs: 10,
    errorCode: null,
    errorMessage: null,
    metadata,
  };
}

const record = (
  a: FastifyInstance,
  monitorId: string,
  o: CheckOutcome<object>,
) =>
  a.commandBus.execute<RecordCheckResultCommandResult>(
    recordCheckResultCommand({ orgId, monitorId, outcome: o }),
  );

const rec = (monitorId: string, o: CheckOutcome<object>) =>
  record(app, monitorId, o);

const sslMonitor = (overrides: object = {}) =>
  createMonitor(app, cookie, serviceId, {
    type: 'ssl_expiry',
    target: '203.0.113.10',
    config: { warnDays: 14 },
    ...overrides,
  });

async function eventsFor(id: string, type?: string) {
  await app.eventBus.drain();
  return emitted.filter(
    (e) => e.payload.monitorId === id && (!type || e.type === type),
  );
}
const warnings = (id: string) => eventsFor(id, 'monitor/ssl_expiry_warning');

async function markers(id: string) {
  return withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<
        {
          certificate_fingerprint: string;
          certificate_expires_at: Date;
        }[]
      >`select certificate_fingerprint, certificate_expires_at
        from monitor_ssl_warnings where monitor_id = ${id}
        order by certificate_fingerprint`,
  );
}

async function resultCount(id: string) {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ n: number }[]>`
        select count(*)::int as n from check_results where monitor_id = ${id}
      `,
  );
  return rows[0].n;
}

async function monitorRow(id: string) {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<
        {
          consecutive_failures: number;
          failure_episode: number;
          last_checked_at: Date | null;
        }[]
      >`select * from monitors where id = ${id}`,
  );
  return rows[0];
}

describe('Story 5.7: SSL expiry warning', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    serviceId = await createService(app, cookie);
    ({ userId: otherUserId, orgId: otherOrgId } = await signUpWithOrg(
      app,
      `${tag}-b`,
    ));
    await createCheckResultPartitions();
    for (const creator of Object.values(events)) {
      if (typeof creator === 'function' && 'type' in creator) {
        app.eventBus.on(creator.type as string, (e: Emitted) =>
          emitted.push({ type: e.type, payload: e.payload }),
        );
      }
    }
  });

  after(async () => {
    await app.eventBus.drain();
    for (const id of [orgId, otherOrgId]) {
      await sql`delete from "organization" where "id" = ${id}`;
    }
    for (const id of [userId, otherUserId]) {
      await sql`delete from "user" where "id" = ${id}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('warns on the first check inside the window', async () => {
    const id = await sslMonitor();
    const o = outcome('AA:01', 10 * DAY);
    await rec(id, o);
    const rows = await markers(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].certificate_fingerprint, 'AA:01');
    assert.equal(
      rows[0].certificate_expires_at.toISOString(),
      (o.metadata as Meta).certificateExpiresAt,
    );
    const list = await warnings(id);
    assert.equal(list.length, 1);
    assert.equal(list[0].payload.certificateFingerprint, 'AA:01');
    assert.equal(
      list[0].payload.certificateExpiresAt,
      (o.metadata as Meta).certificateExpiresAt,
    );
    assert.equal(list[0].payload.orgId, orgId);
    assert.equal(list[0].payload.serviceId, serviceId);
    assert.deepEqual(
      (await eventsFor(id))
        .map((e) => e.type)
        .filter((t) => t !== 'monitor/created'),
      [
        'monitor/check_succeeded',
        'monitor/ssl_expiry_warning',
        'monitor/state_changed',
      ],
    );
  });

  it('isolates markers between organizations', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:ISO', 5 * DAY));
    assert.equal((await markers(id)).length, 1);
    const count = await withTenantTransaction(
      otherOrgId,
      ({ sql: tx }) =>
        tx<{ n: number }[]>`
          select count(*)::int as n from monitor_ssl_warnings
          where monitor_id = ${id}
        `,
    );
    assert.equal(count[0].n, 0);
    await assert.rejects(
      withTenantTransaction(
        otherOrgId,
        ({ sql: tx }) =>
          tx`insert into monitor_ssl_warnings (
              org_id, monitor_id, certificate_fingerprint, certificate_expires_at
            ) values (${orgId}, ${id}, 'AA:EVIL', now())`,
      ),
      (error: { code?: string }) => error.code === '42501',
    );
  });

  it('warns once per monitor for the same fingerprint', async () => {
    const a = await sslMonitor();
    const b = await sslMonitor();
    await rec(a, outcome('AA:SHARED', 5 * DAY));
    await rec(b, outcome('AA:SHARED', 5 * DAY));
    await rec(a, outcome('AA:SHARED', 5 * DAY));
    assert.equal((await warnings(a)).length, 1);
    assert.equal((await warnings(b)).length, 1);
    assert.equal((await markers(a)).length, 1);
    assert.equal((await markers(b)).length, 1);
  });

  it('does not warn again for the same certificate, even on a fresh app', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:02', 10 * DAY));
    await rec(id, outcome('AA:02', 10 * DAY));
    await rec(id, outcome('AA:02', 10 * DAY));
    assert.equal((await warnings(id)).length, 1);

    const second = await buildApp({ logger: false });
    const seen: Emitted[] = [];
    const checks: Emitted[] = [];
    try {
      await second.ready();
      second.eventBus.on(
        events.monitorSslExpiryWarningEvent.type as string,
        (e: Emitted) => seen.push({ type: e.type, payload: e.payload }),
      );
      second.eventBus.on(
        events.monitorCheckSucceededEvent.type as string,
        (e: Emitted) => checks.push({ type: e.type, payload: e.payload }),
      );
      await record(second, id, outcome('AA:02', 10 * DAY));
      await second.eventBus.drain();
    } finally {
      await second.close();
    }
    assert.equal(checks.length, 1);
    assert.equal(seen.length, 0);
    assert.equal((await warnings(id)).length, 1);
    assert.equal((await markers(id)).length, 1);
  });

  it('warns once for each of two alternating certificates', async () => {
    const id = await sslMonitor();
    for (const fp of ['AA:0A', 'AA:0B', 'AA:0A']) {
      await rec(id, outcome(fp, 5 * DAY));
    }
    const list = await warnings(id);
    assert.deepEqual(
      list.map((e) => e.payload.certificateFingerprint),
      ['AA:0A', 'AA:0B'],
    );
    assert.equal((await markers(id)).length, 2);
  });

  it('warns for a renewed certificate only once it is inside the window', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:0A', 5 * DAY));
    await rec(id, outcome('AA:0B', 60 * DAY));
    assert.equal((await warnings(id)).length, 1);
    await rec(id, outcome('AA:0B', 10 * DAY));
    const list = await warnings(id);
    assert.deepEqual(
      list.map((e) => e.payload.certificateFingerprint),
      ['AA:0A', 'AA:0B'],
    );
  });

  it('warns at exactly warnDays but not 1 ms beyond', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:0C', 14 * DAY));
    await rec(id, outcome('AA:0D', 14 * DAY + 1));
    const list = await warnings(id);
    assert.deepEqual(
      list.map((e) => e.payload.certificateFingerprint),
      ['AA:0C'],
    );
  });

  it('records nothing when no certificate was retrieved', async () => {
    const id = await sslMonitor();
    await rec(id, outcome(null, null, { status: 'failure' }));
    assert.equal((await markers(id)).length, 0);
    assert.equal((await warnings(id)).length, 0);
    assert.equal((await eventsFor(id, 'monitor/check_failed')).length, 1);
  });

  it('warns for an expired certificate', async () => {
    const id = await sslMonitor();
    await rec(
      id,
      outcome('AA:0E', -DAY, {
        status: 'failure',
        code: 'certificate_expired',
      }),
    );
    assert.equal((await warnings(id)).length, 1);
  });

  it('warns for an untrusted certificate inside the window, not outside', async () => {
    const id = await sslMonitor();
    const untrusted = {
      status: 'failure',
      code: 'certificate_untrusted',
    } as const;
    await rec(id, outcome('AA:0F', 5 * DAY, untrusted));
    await rec(id, outcome('AA:10', 30 * DAY, untrusted));
    const list = await warnings(id);
    assert.deepEqual(
      list.map((e) => e.payload.certificateFingerprint),
      ['AA:0F'],
    );
  });

  it('does not warn again when a warned certificate later expires', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:11', 5 * DAY));
    await rec(
      id,
      outcome('AA:11', -DAY, {
        status: 'failure',
        code: 'certificate_expired',
      }),
    );
    assert.equal((await warnings(id)).length, 1);
  });

  it('leaves counters alone and emits check then warning on a healthy monitor', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:12', 60 * DAY));
    emitted.length = 0;
    const before = await monitorRow(id);
    await rec(id, outcome('AA:13', 5 * DAY));
    const after = await monitorRow(id);
    assert.equal(after.consecutive_failures, 0);
    assert.equal(after.failure_episode, before.failure_episode);
    const list = await eventsFor(id);
    assert.deepEqual(
      list.map((e) => e.type),
      ['monitor/check_succeeded', 'monitor/ssl_expiry_warning'],
    );
    const rows = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ status: string }[]>`
          select status from check_results where monitor_id = ${id}
            and metadata->>'certificateFingerprint' = 'AA:13'
        `,
    );
    assert.deepEqual(
      rows.map((r) => r.status),
      ['success'],
    );
  });

  it('ignores a non-SSL monitor whose metadata has the fields', async () => {
    const id = await createMonitor(app, cookie, serviceId);
    await rec(id, outcome('AA:14', 5 * DAY));
    assert.equal((await markers(id)).length, 0);
    assert.equal((await warnings(id)).length, 0);
  });

  it('warns for a disabled monitor without touching its state', async () => {
    const id = await sslMonitor({ enabled: false });
    const t = new Date(base.getTime() - 60_000);
    await setMonitorCheckState(orgId, id, {
      consecutiveFailures: 2,
      failureEpisode: 1,
      lastCheckedAt: t,
    });
    emitted.length = 0;
    await rec(id, outcome('AA:15', 5 * DAY));
    assert.equal((await markers(id)).length, 1);
    assert.equal((await warnings(id)).length, 1);
    const saved = await monitorRow(id);
    assert.equal(saved.consecutive_failures, 2);
    assert.equal(saved.failure_episode, 1);
    assert.equal(saved.last_checked_at?.getTime(), t.getTime());
    assert.deepEqual(
      (await eventsFor(id)).map((e) => e.type),
      ['monitor/check_succeeded', 'monitor/ssl_expiry_warning'],
    );
  });

  it('serializes two concurrent records of a new certificate', async () => {
    const id = await sslMonitor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withTenantTransaction(orgId, async ({ sql: tx }) => {
      await tx`select id from monitors where id = ${id} for no key update`;
      locked();
      await gate;
    });
    await Promise.race([hasLock, holder]);

    let settled = 0;
    let pending: Promise<unknown[]>;
    try {
      const track = (p: Promise<unknown>) =>
        p.then((v) => {
          settled++;
          return v;
        });
      pending = Promise.all([
        track(rec(id, outcome('AA:16', 5 * DAY))),
        track(rec(id, outcome('AA:16', 5 * DAY))),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, 0, 'a check settled while the row was locked');
    } finally {
      release();
      await holder;
    }
    await pending;
    assert.equal((await markers(id)).length, 1);
    assert.equal((await warnings(id)).length, 1);
    assert.equal(await resultCount(id), 2);
  });

  it('rolls everything back when the transaction fails, and a retry warns once', async () => {
    const id = await sslMonitor();
    const repo = app.diContainer.resolve('monitorRepository' as never) as {
      recordCheck: (...a: unknown[]) => Promise<void>;
    };
    const original = repo.recordCheck;
    emitted.length = 0;
    const o = outcome('AA:17', 5 * DAY);
    repo.recordCheck = async () => {
      throw new Error('boom');
    };
    try {
      await assert.rejects(rec(id, o), /boom/);
    } finally {
      repo.recordCheck = original;
    }
    assert.equal((await markers(id)).length, 0);
    assert.equal(await resultCount(id), 0);
    assert.deepEqual(await eventsFor(id), []);
    await rec(id, o);
    assert.equal((await warnings(id)).length, 1);
    assert.equal((await markers(id)).length, 1);
  });

  it('refuses update and delete on the table', async () => {
    const id = await sslMonitor();
    await rec(id, outcome('AA:18', 5 * DAY));
    const refused = (run: Promise<unknown>) =>
      assert.rejects(run, (error: { code?: string }) => error.code === '42501');
    await refused(
      withTenantTransaction(
        orgId,
        ({ sql: tx }) =>
          tx`update monitor_ssl_warnings set warned_at = now() where monitor_id = ${id}`,
      ),
    );
    await refused(
      withTenantTransaction(
        orgId,
        ({ sql: tx }) =>
          tx`delete from monitor_ssl_warnings where monitor_id = ${id}`,
      ),
    );
    assert.equal((await markers(id)).length, 1);
  });
});
