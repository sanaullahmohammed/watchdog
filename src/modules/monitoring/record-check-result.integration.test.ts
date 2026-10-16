import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { NotFoundException } from '@/shared/exceptions';
import {
  createCheckResultPartitions,
  createMonitor,
  createService,
  setMonitorCheckState,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import type {
  CheckOutcome,
  SslExpiryCheckMetadata,
} from './checks/check-outcome';

/**
 * Story 5.6: record a check result and count consecutive failures.
 * Runs no worker pass and never orders rows by time (AGENTS.md clock skew).
 */

const tag = `rcr-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let otherUserId = '';
let otherOrgId = '';
let otherCookie = '';
let serviceId = '';
let otherServiceId = '';
const base = new Date();
let tick = 0;

type Emitted = { type: string; payload: Record<string, unknown> };
const emitted: Emitted[] = [];

const nextTime = () => new Date(base.getTime() + tick++);

const ok = (): CheckOutcome => ({
  status: 'success',
  checkedAt: nextTime(),
  latencyMs: 12,
  errorCode: null,
  errorMessage: null,
  metadata: { statusCode: 200, redirects: 0 },
});

const fail = (): CheckOutcome => ({
  status: 'failure',
  checkedAt: nextTime(),
  latencyMs: null,
  errorCode: 'timeout',
  errorMessage: 'timed out',
  metadata: { statusCode: null, redirects: 0 },
});

const record = (monitorId: string, outcome: CheckOutcome<object>, as = orgId) =>
  app.commandBus.execute<RecordCheckResultCommandResult>(
    recordCheckResultCommand({ orgId: as, monitorId, outcome }),
  );

type MonitorRow = {
  consecutive_failures: number;
  failure_episode: number;
  last_checked_at: Date | null;
};

async function row(id: string): Promise<MonitorRow> {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) => tx<MonitorRow[]>`select * from monitors where id = ${id}`,
  );
  return rows[0];
}

async function resultCount(id: string): Promise<number> {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ n: number }[]>`
        select count(*)::int as n from check_results where monitor_id = ${id}
      `,
  );
  return rows[0].n;
}

async function eventsFor(id: string): Promise<Emitted[]> {
  await app.eventBus.drain();
  return emitted.filter((e) => e.payload.monitorId === id);
}

const stateChain = (list: Emitted[]) =>
  list
    .filter((e) => e.type === 'monitor/state_changed')
    .map((e) => [e.payload.from, e.payload.to]);

const ofType = (list: Emitted[], type: string) =>
  list.filter((e) => e.type === type);

async function newMonitor(failureThreshold: number, overrides: object = {}) {
  return createMonitor(app, cookie, serviceId, {
    failureThreshold,
    ...overrides,
  });
}

describe('Story 5.6: record a check result', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    ({
      cookie: otherCookie,
      userId: otherUserId,
      orgId: otherOrgId,
    } = await signUpWithOrg(app, `${tag}-b`));
    serviceId = await createService(app, cookie);
    otherServiceId = await createService(app, otherCookie);
    await createCheckResultPartitions();

    const registered: string[] = [];
    for (const creator of Object.values(events)) {
      if (typeof creator === 'function' && 'type' in creator) {
        registered.push(creator.type as string);
        app.eventBus.on(creator.type as string, (e: Emitted) =>
          emitted.push({ type: e.type, payload: e.payload }),
        );
      }
    }
    // Every observed type is a DOMAIN monitor catalog name.
    assert.deepEqual(
      registered.sort(),
      [
        'monitor/created',
        'monitor/updated',
        'monitor/state_changed',
        'monitor/check_succeeded',
        'monitor/check_failed',
        'monitor/threshold_breached',
        'monitor/recovered',
      ].sort(),
    );
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

  it('walks F,F,F,S,F,F,F,F through two episodes', async () => {
    const id = await newMonitor(3);
    const outcomes = [
      fail(),
      fail(),
      fail(),
      ok(),
      fail(),
      fail(),
      fail(),
      fail(),
    ];
    for (const outcome of outcomes) {
      await record(id, outcome);
    }
    const list = await eventsFor(id);
    const named = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ name: string }[]>`select name from monitors where id = ${id}`,
    );
    const common = {
      orgId,
      monitorId: id,
      serviceId,
      monitorName: named[0].name,
    };
    assert.deepEqual(stateChain(list), [
      [null, 'degraded'],
      ['degraded', 'failing'],
      ['failing', 'healthy'],
      ['healthy', 'degraded'],
      ['degraded', 'failing'],
    ]);
    assert.deepEqual(ofType(list, 'monitor/state_changed')[1].payload, {
      ...common,
      from: 'degraded',
      to: 'failing',
      failureEpisode: 1,
    });
    assert.deepEqual(
      ofType(list, 'monitor/threshold_breached').map((e) => e.payload),
      [
        { ...common, failureEpisode: 1 },
        { ...common, failureEpisode: 2 },
      ],
    );
    assert.deepEqual(
      ofType(list, 'monitor/recovered').map((e) => e.payload),
      [{ ...common, failureEpisode: 1 }],
    );
    const failed = ofType(list, 'monitor/check_failed');
    assert.equal(failed.length, 7);
    assert.deepEqual(failed[0].payload, {
      ...common,
      checkedAt: outcomes[0].checkedAt.toISOString(),
      errorCode: 'timeout',
    });
    const succeeded = ofType(list, 'monitor/check_succeeded');
    assert.equal(succeeded.length, 1);
    assert.deepEqual(succeeded[0].payload, {
      ...common,
      checkedAt: outcomes[3].checkedAt.toISOString(),
    });
    const saved = await row(id);
    assert.equal(saved.failure_episode, 2);
    assert.equal(saved.consecutive_failures, 4);
    assert.equal(await resultCount(id), 8);
  });

  it('orders events within one check: check, state, threshold', async () => {
    const id = await newMonitor(1);
    emitted.length = 0;
    await record(id, fail());
    await app.eventBus.drain();
    assert.deepEqual(
      emitted.filter((e) => e.payload.monitorId === id).map((e) => e.type),
      [
        'monitor/check_failed',
        'monitor/state_changed',
        'monitor/threshold_breached',
      ],
    );
  });

  it('orders a recovery: check, state, recovered', async () => {
    const id = await newMonitor(1);
    await record(id, fail());
    emitted.length = 0;
    await record(id, ok());
    await app.eventBus.drain();
    assert.deepEqual(
      emitted.filter((e) => e.payload.monitorId === id).map((e) => e.type),
      ['monitor/check_succeeded', 'monitor/state_changed', 'monitor/recovered'],
    );
  });

  it('a failed transaction stores nothing and emits nothing', async () => {
    const id = await newMonitor(3);
    const t = new Date(base.getTime() - 60_000);
    await setMonitorCheckState(orgId, id, {
      consecutiveFailures: 1,
      failureEpisode: 0,
      lastCheckedAt: t,
    });
    emitted.length = 0;
    const outcome = { ...fail(), checkedAt: new Date('2000-01-01T00:00:00Z') };
    await assert.rejects(record(id, outcome));
    assert.equal(await resultCount(id), 0);
    const saved = await row(id);
    assert.equal(saved.consecutive_failures, 1);
    assert.equal(saved.failure_episode, 0);
    assert.equal(saved.last_checked_at?.getTime(), t.getTime());
    assert.deepEqual(await eventsFor(id), []);
  });

  it('a first success moves null to healthy without recovered', async () => {
    const id = await newMonitor(3);
    await record(id, ok());
    const list = await eventsFor(id);
    assert.deepEqual(stateChain(list), [[null, 'healthy']]);
    assert.equal(ofType(list, 'monitor/recovered').length, 0);
    assert.equal((await row(id)).failure_episode, 0);
  });

  it('threshold 1 goes null to failing and never degraded', async () => {
    const id = await newMonitor(1);
    await record(id, fail());
    const list = await eventsFor(id);
    assert.deepEqual(stateChain(list), [[null, 'failing']]);
    assert.equal(
      ofType(list, 'monitor/threshold_breached')[0].payload.failureEpisode,
      1,
    );
  });

  it('an unchanged state stores the row and emits only the check event', async () => {
    const id = await newMonitor(3);
    await record(id, ok());
    emitted.length = 0;
    await record(id, ok());
    const list = await eventsFor(id);
    assert.deepEqual(
      list.map((e) => e.type),
      ['monitor/check_succeeded'],
    );
    assert.equal(await resultCount(id), 2);
  });

  it('stores the row content, truncating the message and keeping metadata', async () => {
    const id = await newMonitor(3, {
      type: 'ssl_expiry',
      target: '203.0.113.10:443',
      config: { warnDays: 14 },
    });
    const outcome: CheckOutcome<SslExpiryCheckMetadata> = {
      status: 'failure',
      checkedAt: nextTime(),
      latencyMs: 40,
      errorCode: 'certificate_untrusted',
      errorMessage: 'x'.repeat(700),
      metadata: {
        certificateFingerprint: 'AA:BB',
        certificateExpiresAt: null,
        daysRemaining: null,
      },
    };
    const resultId = await record(id, outcome);
    const rows = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<
          {
            id: string;
            service_id: string;
            status: string;
            latency_ms: number;
            error_code: string;
            error_message: string;
            metadata: unknown;
            checked_at: Date;
          }[]
        >`select * from check_results where monitor_id = ${id}`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, resultId);
    assert.equal(rows[0].service_id, serviceId);
    assert.equal(rows[0].status, 'failure');
    assert.equal(rows[0].latency_ms, 40);
    assert.equal(rows[0].error_code, 'certificate_untrusted');
    assert.equal(rows[0].error_message, 'x'.repeat(512));
    assert.deepEqual(rows[0].metadata, outcome.metadata);
    assert.equal(rows[0].checked_at.getTime(), outcome.checkedAt.getTime());
    assert.equal(
      (await row(id)).last_checked_at?.getTime(),
      outcome.checkedAt.getTime(),
    );
  });

  it('two concurrent failures queue on the row lock and count both', async () => {
    const id = await newMonitor(2);
    await setMonitorCheckState(orgId, id, { consecutiveFailures: 1 });
    emitted.length = 0;

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
        track(record(id, fail())),
        track(record(id, fail())),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, 0, 'a check settled while the row was locked');
    } finally {
      release();
      await holder;
    }
    await pending;

    const saved = await row(id);
    assert.equal(saved.consecutive_failures, 3);
    assert.equal(saved.failure_episode, 1);
    assert.equal(await resultCount(id), 2);
    const list = await eventsFor(id);
    assert.equal(ofType(list, 'monitor/threshold_breached').length, 1);
    assert.deepEqual(stateChain(list), [['degraded', 'failing']]);
  });

  it('a disabled monitor stores the row but leaves its state alone', async () => {
    const id = await newMonitor(3, { enabled: false });
    const t = new Date(base.getTime() - 60_000);
    await setMonitorCheckState(orgId, id, {
      consecutiveFailures: 2,
      failureEpisode: 1,
      lastCheckedAt: t,
    });
    emitted.length = 0;
    await record(id, fail());
    const saved = await row(id);
    assert.equal(saved.consecutive_failures, 2);
    assert.equal(saved.failure_episode, 1);
    assert.equal(saved.last_checked_at?.getTime(), t.getTime());
    assert.equal(await resultCount(id), 1);
    const list = await eventsFor(id);
    assert.deepEqual(
      list.map((e) => e.type),
      ['monitor/check_failed'],
    );
  });

  it('refuses an unknown monitor and one in another organization', async () => {
    const foreign = await createMonitor(app, otherCookie, otherServiceId);
    emitted.length = 0;
    for (const id of [randomUUID(), foreign]) {
      await assert.rejects(record(id, ok()), NotFoundException);
    }
    await app.eventBus.drain();
    assert.equal(emitted.length, 0);
    const rows = await withTenantTransaction(
      otherOrgId,
      ({ sql: tx }) =>
        tx<{ n: number }[]>`
          select count(*)::int as n from check_results where monitor_id = ${foreign}
        `,
    );
    assert.equal(rows[0].n, 0);
  });

  it('refuses a malformed monitor id with a 400 and emits nothing', async () => {
    emitted.length = 0;
    await assert.rejects(record('nope', ok()), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      return true;
    });
    await app.eventBus.drain();
    assert.equal(emitted.length, 0);
  });
});
