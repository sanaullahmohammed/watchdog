import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import config from '@/config/env';
import { checkRegistry } from '@/modules/monitoring/checks/process-check-limiter';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as monitorEvents from '@/shared/events/monitor.events';
import {
  archiveService,
  createCheckResultPartitions,
  createMonitor,
  createService,
  restoreService,
  setMonitorCheckState,
  updateMonitor,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import {
  startTestEndpoints,
  type TestEndpoints,
} from '@/shared/testing/test-endpoints';
import {
  type QueueDueMonitorChecksCommandResult,
  queueDueMonitorChecksCommand,
} from './commands/queue-due-monitor-checks/queue-due-monitor-checks.handler';
import {
  type RunDueMonitorChecksCommandResult,
  runDueMonitorChecksCommand,
} from './commands/run-due-monitor-checks/run-due-monitor-checks.handler';

/**
 * Story 5.8: find and run the checks that are due. Each test runs the command
 * for an organization of its own, because the command visits every due monitor
 * of one, and never orders by time (AGENTS.md clock skew).
 */

const tag = `due-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let endpoints: TestEndpoints;
const savedCidrs = config.monitor.allowedCidrs;
const savedConcurrency = config.monitor.checkConcurrency;
const orgs: { orgId: string; userId: string }[] = [];
let counter = 0;

type Org = { cookie: string; orgId: string; serviceId: string };

async function newOrg(): Promise<Org> {
  counter += 1;
  const { cookie, orgId, userId } = await signUpWithOrg(
    app,
    `${tag}-${counter}`,
  );
  orgs.push({ orgId, userId });
  return { cookie, orgId, serviceId: await createService(app, cookie) };
}

// Every line the app logs, so a test can tell a quiet skip from a logged error.
const logLines: { level: number; msg?: string; [key: string]: unknown }[] = [];
const loggerInstance = pino(
  { level: 'debug' },
  {
    write(line: string) {
      logLines.push(JSON.parse(line));
    },
  },
);
const errorLines = () => logLines.filter((line) => line.level >= 50);

const queue = (orgId: string, now?: Date) =>
  app.commandBus.execute<QueueDueMonitorChecksCommandResult>(
    queueDueMonitorChecksCommand({ orgId, now }),
  );

async function waitFor(what: string, probe: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type MonitorRepo = {
  listDue: (...args: never[]) => Promise<unknown[]>;
  getForUpdate: (...args: never[]) => Promise<unknown>;
};
const monitorRepo = () =>
  app.diContainer.resolve('monitorRepository' as never) as MonitorRepo;

const run = (orgId: string, now?: Date) =>
  app.commandBus.execute<RunDueMonitorChecksCommandResult>(
    runDueMonitorChecksCommand({ orgId, now }),
  );

type ResultRow = {
  status: string;
  error_code: string | null;
  metadata: Record<string, unknown>;
};

async function results(orgId: string, monitorId: string) {
  return withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<ResultRow[]>`
        select status, error_code, metadata from check_results
        where monitor_id = ${monitorId}
      `,
  );
}

const make = (org: Org, overrides: object = {}) =>
  createMonitor(app, org.cookie, org.serviceId, {
    intervalSeconds: 60,
    target: `${endpoints.origin}/ok`,
    ...overrides,
  });

async function xmin(orgId: string, monitorId: string) {
  const rows = await withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ x: string }[]>`
        select xmin::text as x from monitors where id = ${monitorId}
      `,
  );
  return rows[0].x;
}

describe('Story 5.8: find and run the checks that are due', () => {
  before(async () => {
    config.monitor.allowedCidrs = parseAllowedCidrs('127.0.0.0/8');
    endpoints = await startTestEndpoints();
    app = await buildApp({ loggerInstance });
    await app.ready();
    await createCheckResultPartitions();
  });

  afterEach(async () => {
    // The registry is process-wide: nothing queued here may outlive its test.
    await checkRegistry.drain();
    checkRegistry.reset();
    config.monitor.checkConcurrency = savedConcurrency;
  });

  after(async () => {
    config.monitor.allowedCidrs = savedCidrs;
    config.monitor.checkConcurrency = savedConcurrency;
    await app.eventBus.drain();
    for (const { orgId, userId } of orgs) {
      await sql`delete from "organization" where "id" = ${orgId}`;
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await endpoints.close();
    await sql.end({ timeout: 5 });
  });

  it('checks the due monitors and leaves the others alone', async () => {
    const org = await newOrg();
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms);
    const a = await make(org);
    const b = await make(org);
    const c = await make(org);
    const d = await make(org, { enabled: false });
    const e = await make(org);
    await setMonitorCheckState(org.orgId, a, {
      consecutiveFailures: 0,
      lastCheckedAt: at(60_000),
    });
    await setMonitorCheckState(org.orgId, b, {
      consecutiveFailures: 0,
      lastCheckedAt: at(59_999),
    });
    await setMonitorCheckState(org.orgId, e, {
      consecutiveFailures: 0,
      lastCheckedAt: at(3_600_000),
    });
    await setMonitorCheckState(org.orgId, c, {
      consecutiveFailures: 0,
      lastCheckedAt: null,
    });

    assert.deepEqual(await run(org.orgId, now), { checked: 3 });
    for (const id of [a, c, e])
      assert.equal((await results(org.orgId, id)).length, 1);
    for (const id of [b, d])
      assert.equal((await results(org.orgId, id)).length, 0);
  });

  it('runs the adapter for every monitor type', async () => {
    const org = await newOrg();
    const http = await make(org);
    const keyword = await make(org, {
      type: 'keyword',
      target: `${endpoints.origin}/body?size=100&keyword=needle&at=10`,
      config: { keyword: 'needle' },
    });
    const tcp = await make(org, {
      type: 'tcp',
      target: `127.0.0.1:${endpoints.port}`,
    });
    const ssl = await make(org, {
      type: 'ssl_expiry',
      target: `127.0.0.1:${new URL(endpoints.httpsOrigin).port}`,
      config: { warnDays: 30 },
    });

    assert.deepEqual(await run(org.orgId), { checked: 4 });
    for (const id of [http, keyword, tcp]) {
      const [row] = await results(org.orgId, id);
      assert.equal(row.status, 'success', JSON.stringify(row));
    }
    const [sslRow] = await results(org.orgId, ssl);
    assert.equal(sslRow.status, 'failure');
    assert.equal(sslRow.error_code, 'certificate_untrusted');
    assert.ok(sslRow.metadata.certificateFingerprint);
  });

  it('skips the monitors of an archived service', async () => {
    const org = await newOrg();
    const enabled = await make(org);
    const disabled = await make(org, { enabled: false });
    await archiveService(app, org.cookie, org.serviceId);
    const before = [
      await xmin(org.orgId, enabled),
      await xmin(org.orgId, disabled),
    ];

    assert.deepEqual(await run(org.orgId), { checked: 0 });
    for (const id of [enabled, disabled]) {
      assert.equal((await results(org.orgId, id)).length, 0);
    }
    assert.deepEqual(
      [await xmin(org.orgId, enabled), await xmin(org.orgId, disabled)],
      before,
    );
  });

  it('resumes the enabled monitors of a restored service', async () => {
    const org = await newOrg();
    const now = new Date();
    const fresh = await make(org);
    const recent = await make(org);
    const disabled = await make(org, { enabled: false });
    await setMonitorCheckState(org.orgId, recent, {
      consecutiveFailures: 0,
      lastCheckedAt: new Date(now.getTime() - 10_000),
    });
    await archiveService(app, org.cookie, org.serviceId);
    await restoreService(app, org.cookie, org.serviceId);

    assert.deepEqual(await run(org.orgId, now), { checked: 1 });
    assert.equal((await results(org.orgId, fresh)).length, 1);
    assert.equal((await results(org.orgId, recent)).length, 0);

    await setMonitorCheckState(org.orgId, recent, {
      consecutiveFailures: 0,
      lastCheckedAt: new Date(now.getTime() - 60_000),
    });
    assert.deepEqual(await run(org.orgId, now), { checked: 1 });
    assert.equal((await results(org.orgId, recent)).length, 1);
    assert.equal((await results(org.orgId, fresh)).length, 1);
    assert.equal((await results(org.orgId, disabled)).length, 0);
  });

  it('never runs more checks at once than the cap, across organizations', async () => {
    const first = await newOrg();
    const second = await newOrg();
    const placed: [Org, string][] = [];
    for (const org of [first, first, first, second, second]) {
      placed.push([
        org,
        await make(org, { target: `${endpoints.origin}/hold?delay=400` }),
      ]);
    }
    config.monitor.checkConcurrency = 2;
    endpoints.reset();
    try {
      const counts = await Promise.all([run(first.orgId), run(second.orgId)]);
      assert.deepEqual(counts, [{ checked: 3 }, { checked: 2 }]);
    } finally {
      config.monitor.checkConcurrency = savedConcurrency;
    }
    assert.equal(endpoints.peakInFlight(), 2);
    for (const [org, id] of placed) {
      assert.equal((await results(org.orgId, id)).length, 1);
    }
  });

  it('holds a slot until the record settles', async () => {
    const org = await newOrg();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await make(org));
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: unknown) => Promise<string>;
    };
    const original = repo.append;
    let inFlight = 0;
    let peak = 0;
    repo.append = async (tx, row) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return await original.call(repo, tx, row);
      } finally {
        inFlight -= 1;
      }
    };
    config.monitor.checkConcurrency = 2;
    try {
      assert.deepEqual(await run(org.orgId), { checked: 5 });
    } finally {
      repo.append = original;
      config.monitor.checkConcurrency = savedConcurrency;
    }
    assert.equal(peak, 2);
    for (const id of ids)
      assert.equal((await results(org.orgId, id)).length, 1);
  });

  it('records a timeout without holding up the others', async () => {
    const org = await newOrg();
    const silent = await make(org, {
      target: `${endpoints.origin}/silent`,
      timeoutSeconds: 1,
    });
    const ok = [await make(org), await make(org)];

    const started = performance.now();
    assert.deepEqual(await run(org.orgId), { checked: 3 });
    assert.ok(performance.now() - started < 5_000);

    const [row] = await results(org.orgId, silent);
    assert.equal(row.status, 'failure');
    assert.equal(row.error_code, 'timeout');
    for (const id of ok) {
      assert.equal((await results(org.orgId, id))[0].status, 'success');
    }
  });

  it('records the others when one record rejects, then rethrows', async () => {
    const org = await newOrg();
    const ids = [await make(org), await make(org), await make(org)];
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: { monitorId: string }) => Promise<string>;
    };
    const original = repo.append;
    const failure = new Error('append failed');
    repo.append = (tx, row) =>
      row.monitorId === ids[1]
        ? Promise.reject(failure)
        : original.call(repo, tx, row);
    try {
      await assert.rejects(run(org.orgId), (error) => error === failure);
    } finally {
      repo.append = original;
    }
    assert.equal((await results(org.orgId, ids[0])).length, 1);
    assert.equal((await results(org.orgId, ids[1])).length, 0);
    assert.equal((await results(org.orgId, ids[2])).length, 1);
  });

  it('rethrows every reason when several records reject', async () => {
    const org = await newOrg();
    const ids = [await make(org), await make(org), await make(org)];
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: { monitorId: string }) => Promise<string>;
    };
    const original = repo.append;
    const errors = [new Error('first'), new Error('second')];
    repo.append = (tx, row) => {
      const at = [ids[0], ids[1]].indexOf(row.monitorId);
      return at >= 0
        ? Promise.reject(errors[at])
        : original.call(repo, tx, row);
    };
    try {
      await assert.rejects(run(org.orgId), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.deepEqual([...error.errors].sort(), [...errors].sort());
        return true;
      });
    } finally {
      repo.append = original;
    }
    assert.equal((await results(org.orgId, ids[2])).length, 1);
  });

  it("leaves another organization's monitors alone", async () => {
    const mine = await newOrg();
    const theirs = await newOrg();
    await make(mine);
    const other = await make(theirs);

    assert.deepEqual(await run(mine.orgId), { checked: 1 });
    assert.equal((await results(theirs.orgId, other)).length, 0);
  });

  it('keys the limiter by organization, so a small organization is not queued behind a large one', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const aIds: string[] = [];
    for (const n of [1, 2, 3]) {
      aIds.push(
        await make(a, { target: `${endpoints.origin}/hold?delay=300&m=a${n}` }),
      );
    }
    const bId = await make(b, {
      target: `${endpoints.origin}/hold?delay=300&m=b1`,
    });
    config.monitor.checkConcurrency = 1;
    endpoints.reset();
    try {
      const first = run(a.orgId);
      let firstFailure: unknown;
      first.catch((error: unknown) => {
        firstFailure = error;
      });
      // B starts only once A holds the one slot, so A's other two checks are
      // already queued when B's arrives. FIFO would run B last.
      const deadline = Date.now() + 10_000;
      while (endpoints.requests.length < 1) {
        if (firstFailure !== undefined) throw firstFailure;
        if (Date.now() > deadline) {
          throw new Error(
            "timed out waiting for organization A's first request",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const second = run(b.orgId);
      await Promise.all([first, second]);
    } finally {
      config.monitor.checkConcurrency = savedConcurrency;
    }
    // Arrival order at the endpoint, not a clock.
    const order = endpoints.requests.map((url) => url.split('m=')[1]);
    assert.equal(order.length, 4);
    assert.equal(order[1], 'b1');
    assert.equal((await results(b.orgId, bId)).length, 1);
    for (const id of aIds) {
      assert.equal((await results(a.orgId, id)).length, 1);
    }
  });

  it('queues a due monitor once, then again only after it is recorded', async () => {
    const org = await newOrg();
    const id = await make(org, {
      target: `${endpoints.origin}/hold?delay=5000`,
    });
    const now = new Date();

    assert.deepEqual(await queue(org.orgId, now), { queued: 1, skipped: 0 });
    // Still queued or running: not queued again, and run_due_checks does not
    // wait for or repeat a check someone else registered.
    assert.deepEqual(await queue(org.orgId, now), { queued: 0, skipped: 1 });
    assert.deepEqual(await run(org.orgId, now), { checked: 0 });
    await checkRegistry.drain();
    assert.equal((await results(org.orgId, id)).length, 1);

    const later = new Date(Date.now() + 120_000);
    assert.deepEqual(await queue(org.orgId, later), { queued: 1, skipped: 0 });
    await checkRegistry.drain();
    assert.equal((await results(org.orgId, id)).length, 2);
  });

  it('skips a monitor whose earlier check recorded between the listing and the queueing', async () => {
    const org = await newOrg();
    const id = await make(org);
    const now = new Date();
    const repo = monitorRepo();
    const original = repo.listDue;
    const stale = await withTenantTransaction(org.orgId, (tx) =>
      (original as (...a: unknown[]) => Promise<unknown[]>).call(repo, tx, now),
    );
    assert.equal(stale.length, 1);

    assert.deepEqual(await run(org.orgId, now), { checked: 1 });
    repo.listDue = async () => stale;
    try {
      assert.deepEqual(await queue(org.orgId, now), { queued: 1, skipped: 0 });
      await checkRegistry.drain();
    } finally {
      repo.listDue = original;
    }
    assert.equal((await results(org.orgId, id)).length, 1);
  });

  it('skips a monitor that no longer exists', async () => {
    const org = await newOrg();
    await make(org);
    const now = new Date();
    const repo = monitorRepo();
    const original = repo.listDue;
    const [real] = (await withTenantTransaction(org.orgId, (tx) =>
      (original as (...a: unknown[]) => Promise<unknown[]>).call(repo, tx, now),
    )) as { id: string }[];
    repo.listDue = async () => [
      { ...real, id: '00000000-0000-4000-8000-000000000000' },
    ];
    const before = errorLines().length;
    try {
      assert.deepEqual(await queue(org.orgId, now), { queued: 1, skipped: 0 });
      await checkRegistry.drain();
      assert.deepEqual(await run(org.orgId, now), { checked: 0 });
    } finally {
      repo.listDue = original;
    }
    assert.equal(errorLines().length, before);
    assert.equal((await results(org.orgId, real.id)).length, 0);
  });

  it('re-reads a queued monitor: skips a disabled or archived one, checks an edited one against its new target', async () => {
    const blocked = await newOrg();
    const disabledOrg = await newOrg();
    const archivedOrg = await newOrg();
    await make(blocked, { target: `${endpoints.origin}/hold?delay=5000` });
    const edited = await make(disabledOrg, {
      target: `${endpoints.origin}/error`,
      failureThreshold: 5,
    });
    const disabled = await make(disabledOrg, {
      target: `${endpoints.origin}/ok?m=disabled`,
    });
    const archived = await make(archivedOrg);
    config.monitor.checkConcurrency = 1;
    endpoints.reset();
    const before = errorLines().length;
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    for (const creator of Object.values(monitorEvents)) {
      if (typeof creator === 'function' && 'type' in creator) {
        app.eventBus.on(creator.type as string, (e: (typeof seen)[number]) =>
          seen.push({ type: e.type, payload: e.payload }),
        );
      }
    }

    // The blocker holds the one slot, so the others are queued behind it.
    await queue(blocked.orgId);
    await waitFor('the blocker to hold the slot', () =>
      endpoints.requests.some((r) => r.startsWith('/hold')),
    );
    await queue(disabledOrg.orgId);
    await queue(archivedOrg.orgId);
    await updateMonitor(app, disabledOrg.cookie, disabled, { enabled: false });
    await updateMonitor(app, disabledOrg.cookie, edited, {
      target: `${endpoints.origin}/ok?m=edited`,
    });
    await archiveService(app, archivedOrg.cookie, archivedOrg.serviceId);
    await checkRegistry.drain();
    await app.eventBus.drain();

    assert.equal((await results(disabledOrg.orgId, disabled)).length, 0);
    assert.equal((await results(archivedOrg.orgId, archived)).length, 0);
    const editedRows = await results(disabledOrg.orgId, edited);
    assert.equal(editedRows.length, 1);
    assert.equal(editedRows[0].status, 'success');
    assert.equal(errorLines().length, before);
    // Skipped monitors emit no monitor event.
    assert.deepEqual(
      seen.filter(
        (e) =>
          (e.payload.monitorId === disabled ||
            e.payload.monitorId === archived) &&
          // The test's own edits emit these; a check would emit the rest.
          e.type !== 'monitor/created' &&
          e.type !== 'monitor/updated',
      ),
      [],
    );
  });

  it('logs a failed record with its ids, records the others, and lists the monitor again', async () => {
    const org = await newOrg();
    const ids = [await make(org), await make(org), await make(org)];
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: (tx: never, row: { monitorId: string }) => Promise<string>;
    };
    const original = repo.append;
    repo.append = (tx, row) =>
      row.monitorId === ids[1]
        ? Promise.reject(new Error('append failed'))
        : original.call(repo, tx, row);
    const before = errorLines().length;
    try {
      assert.deepEqual(await queue(org.orgId), { queued: 3, skipped: 0 });
      await checkRegistry.drain();
    } finally {
      repo.append = original;
    }
    assert.equal((await results(org.orgId, ids[0])).length, 1);
    assert.equal((await results(org.orgId, ids[1])).length, 0);
    assert.equal((await results(org.orgId, ids[2])).length, 1);
    const logged = errorLines().slice(before);
    assert.ok(
      logged.some(
        (line) => line.monitorId === ids[1] && line.orgId === org.orgId,
      ),
    );

    // last_checked_at is as it was, so only the failed one is due again.
    assert.deepEqual(await queue(org.orgId), { queued: 1, skipped: 0 });
    await checkRegistry.drain();
    assert.equal((await results(org.orgId, ids[1])).length, 1);
  });

  it('counts a record that finds the monitor gone as skipped, without an error', async () => {
    const org = await newOrg();
    const id = await make(org);
    const now = new Date();
    const repo = monitorRepo();
    // The row is gone by the time the result is recorded.
    const original = repo.getForUpdate;
    repo.getForUpdate = async () => null;
    const before = errorLines().length;
    try {
      assert.deepEqual(await queue(org.orgId, now), { queued: 1, skipped: 0 });
      await checkRegistry.drain();
      // The monitor is still due (nothing was recorded) and the record path
      // finds it gone again: run_due_checks resolves, it does not reject.
      assert.deepEqual(await run(org.orgId, now), { checked: 0 });
    } finally {
      repo.getForUpdate = original;
    }
    assert.equal(errorLines().length, before);
    assert.equal((await results(org.orgId, id)).length, 0);
  });
});
