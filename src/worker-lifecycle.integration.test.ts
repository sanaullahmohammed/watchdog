import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import config from '@/config/env';
import { checkRegistry } from '@/modules/monitoring/checks/process-check-limiter';
import { buildApp } from '@/server/build-app';
import sql, { closeDbConnection } from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  createCheckResultPartitions,
  createMonitor,
  createService,
  updateMonitor,
} from '@/shared/testing/fixtures';
import { signUpWithOrg } from '@/shared/testing/tenant';
import {
  startTestEndpoints,
  type TestEndpoints,
} from '@/shared/testing/test-endpoints';
import {
  runHealthcheck,
  type ScopedWorker,
  spawnScopedWorker,
} from '@/shared/testing/worker-process';
import { createWorkerHealth, type WorkerHealthRecord } from '@/worker-health';
import { runMonitorPass, startLoop } from './worker';

/**
 * Story 5.9: the worker runs checks on its own loop. The real worker runs in a
 * child process scoped to this file's organizations, so its healthcheck and its
 * SIGTERM are driven for real. Waits poll the heartbeat file or an endpoint;
 * nothing sleeps for a fixed time or compares a timestamp with this clock.
 */

const INTERVAL_MS = 1_000;
const BAD_ORG_ID = 'not a valid id!';
const tag = `life-${randomBytes(4).toString('hex')}`;
const directory = mkdtempSync(join(tmpdir(), 'watchdog-lifecycle-'));

let app: FastifyInstance;
let endpoints: TestEndpoints;
const savedCidrs = config.monitor.allowedCidrs;
const orgs: { orgId: string; userId: string }[] = [];
const children: ScopedWorker[] = [];
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

async function deleteOrgs() {
  while (orgs.length > 0) {
    const { orgId, userId } = orgs[0];
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    orgs.shift();
  }
}

const make = (org: Org, path: string, overrides: object = {}) =>
  createMonitor(app, org.cookie, org.serviceId, {
    intervalSeconds: 60,
    target: endpoints.origin + path,
    ...overrides,
  });

async function results(orgId: string, monitorId: string) {
  return withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx<{ status: string; error_code: string | null }[]>`
        select status, error_code from check_results
        where monitor_id = ${monitorId}
      `,
  );
}

function childEnv(heartbeatPath: string, overdueMs: number) {
  return {
    ...process.env,
    LOG_LEVEL: 'info',
    MONITOR_ALLOWED_CIDRS: '127.0.0.0/8',
    WORKER_HEARTBEAT_PATH: heartbeatPath,
    WORKER_MAINTENANCE_INTERVAL_MS: String(INTERVAL_MS),
    WORKER_MONITOR_INTERVAL_MS: String(INTERVAL_MS),
    WORKER_PASS_OVERDUE_MS: String(overdueMs),
  };
}

function readHeartbeat(path: string): WorkerHealthRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkerHealthRecord;
  } catch {
    return null;
  }
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | false> | T | null | false,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function startChild(orgIds: string[], env: NodeJS.ProcessEnv) {
  const worker = spawnScopedWorker(orgIds, env);
  children.push(worker);
  return worker;
}

async function exitWithin(worker: ScopedWorker, ms: number) {
  const guard = setTimeout(() => worker.child.kill('SIGKILL'), ms);
  try {
    return await worker.exit;
  } finally {
    clearTimeout(guard);
  }
}

const capturedLogs: Array<{ obj: unknown; msg?: string }> = [];
const capturingLogger = {
  warn() {},
  info() {},
  error(obj: unknown, msg?: string) {
    capturedLogs.push({ obj, msg });
  },
} as unknown as FastifyBaseLogger;
const quietLogger = {
  warn() {},
  error() {},
  info() {},
} as unknown as FastifyBaseLogger;

describe('Story 5.9: checks run on the worker loop', () => {
  before(async () => {
    config.monitor.allowedCidrs = parseAllowedCidrs('127.0.0.0/8');
    endpoints = await startTestEndpoints();
    app = await buildApp({ logger: false });
    await app.ready();
    // A scoped worker never maintains partitions.
    await createCheckResultPartitions();
  });

  afterEach(async () => {
    // Process-wide: checks queued by an in-process tick must not outlive it.
    await checkRegistry.drain();
    checkRegistry.reset();
  });

  after(async () => {
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
    config.monitor.allowedCidrs = savedCidrs;
    rmSync(directory, { recursive: true, force: true });
    await app.eventBus.drain().catch(() => undefined);
    // Normally a no-op: the discovery test, which runs last, cleans up before it
    // closes the pool. This covers a run that stopped short of it.
    await deleteOrgs().catch(() => undefined);
    await app.close().catch(() => undefined);
    await endpoints.close();
    await closeDbConnection();
  });

  it('is healthy while both loops complete, stays scoped, and exits by itself on SIGTERM', async () => {
    const org = await newOrg();
    // Due too, but left out of the child's argv: the worker must not touch it.
    const outsider = await newOrg();
    const monitorId = await make(org, '/ok');
    const outsiderMonitorId = await make(outsider, '/ok');
    // Drift the outsider's stored status: a maintenance pass that reached it
    // would reconcile the value back.
    await withTenantTransaction(outsider.orgId, async ({ sql: tx }) => {
      await tx`
        update services set last_known_status = 'major_outage'
        where id = ${outsider.serviceId}
      `;
    });
    const path = join(directory, 'healthy');
    const env = childEnv(path, 20_000);
    const worker = startChild([org.orgId], env);

    await waitFor('both loops to complete', () => {
      const loops = readHeartbeat(path)?.loops;
      return (
        loops?.maintenance?.lastCompletedAt != null &&
        loops?.monitor?.lastCompletedAt != null
      );
    });
    await waitFor(
      'the monitor result',
      async () => (await results(org.orgId, monitorId)).length === 1,
    );
    const check = await runHealthcheck(env);
    assert.equal(check.code, 0, check.output + worker.output());

    // One more completed monitor pass after the first, so a pass that reached
    // the outsider would have recorded by now.
    const firstMaintenance =
      readHeartbeat(path)?.loops.maintenance?.lastCompletedAt;
    const firstCompleted = readHeartbeat(path)?.loops.monitor?.lastCompletedAt;
    await waitFor(
      'another monitor pass to complete',
      () =>
        readHeartbeat(path)?.loops.monitor?.lastCompletedAt !== firstCompleted,
    );
    await waitFor(
      'another maintenance pass to complete',
      () =>
        readHeartbeat(path)?.loops.maintenance?.lastCompletedAt !==
        firstMaintenance,
    );
    assert.equal((await results(outsider.orgId, outsiderMonitorId)).length, 0);
    const drifted = await withTenantTransaction(
      outsider.orgId,
      ({ sql: tx }) =>
        tx<{ last_known_status: string }[]>`
          select last_known_status from services where id = ${outsider.serviceId}
        `,
    );
    assert.equal(drifted[0].last_known_status, 'major_outage');

    worker.child.kill('SIGTERM');
    assert.equal(await exitWithin(worker, 20_000), 0, worker.output());
    assert.equal((await results(org.orgId, monitorId)).length, 1);
  });

  it('does not let one organization with many slow targets delay another', async () => {
    const noisy = await newOrg();
    const quiet = await newOrg();
    endpoints.reset();
    for (let n = 0; n < 30; n += 1) {
      await make(noisy, `/silent?m=${n}`, { timeoutSeconds: 1 });
    }
    const path = join(directory, 'noisy-neighbour');
    const env = {
      ...childEnv(path, 4_000),
      MONITOR_CHECK_CONCURRENCY: '2',
    };
    const worker = startChild([noisy.orgId, quiet.orgId], env);
    const count = async (orgId: string) =>
      withTenantTransaction(
        orgId,
        ({ sql: tx }) =>
          tx<{ n: number }[]>`select count(*)::int as n from check_results`,
      ).then((rows) => rows[0].n);

    // The noisy backlog is under way (about 15 s at 2 at a time) before the
    // quiet organization's monitor exists.
    await waitFor('the backlog to be under way', () =>
      endpoints.requests.filter((r) => r.startsWith('/silent')).length >= 2
        ? true
        : null,
    );
    const quietId = await make(quiet, '/ok');

    await waitFor(
      "the quiet organization's result",
      async () => (await results(quiet.orgId, quietId)).length === 1,
      10_000,
    );
    // Probe health only once the backlog has run longer than the overdue
    // window (4 s, so about 8 of the 30 rows at 2 per second), and while it is
    // unfinished. Counted in rows, not by checked_at.
    await waitFor(
      'the backlog to outlast the overdue window',
      async () => (await count(noisy.orgId)) >= 10,
      20_000,
    );
    assert.ok((await count(noisy.orgId)) < 30);
    const completed = readHeartbeat(path)?.loops.monitor?.lastCompletedAt;
    await waitFor(
      'the monitor loop to complete another tick',
      () => {
        const next = readHeartbeat(path)?.loops.monitor?.lastCompletedAt;
        return next != null && next !== completed;
      },
      10_000,
    );
    const check = await runHealthcheck(env);
    assert.equal(check.code, 0, check.output + worker.output());

    worker.child.kill('SIGTERM');
    assert.equal(await exitWithin(worker, 60_000), 0, worker.output());
  });

  it('fails the healthcheck when checks are queued and none settles', async () => {
    const org = await newOrg();
    endpoints.reset();
    await make(org, '/silent', { timeoutSeconds: 40 });
    const path = join(directory, 'stalled');
    const env = childEnv(path, 3_000);
    const worker = startChild([org.orgId], env);

    await waitFor(
      'the tick to report the stall',
      () => worker.output().includes('monitor checks stalled'),
      30_000,
    );
    const check = await waitFor(
      'the healthcheck to fail on the monitor loop',
      async () => {
        const result = await runHealthcheck(env);
        return result.code === 1 && /loop monitor/.test(result.output)
          ? result
          : null;
      },
      30_000,
    );
    assert.match(check.output, /loop monitor/);
    // Maintenance is unaffected by the stalled checks.
    assert.doesNotMatch(check.output, /loop maintenance/);

    // The loop stopped completing: two probes a few ticks apart agree.
    const first = readHeartbeat(path)?.loops.monitor?.lastCompletedAt;
    await new Promise((resolve) => setTimeout(resolve, 3 * INTERVAL_MS));
    assert.equal(readHeartbeat(path)?.loops.monitor?.lastCompletedAt, first);

    worker.child.kill('SIGKILL');
    await worker.exit;
  });

  it('records the check running on SIGTERM as a timeout and drops the queued ones', async () => {
    const org = await newOrg();
    endpoints.reset();
    const ids = [
      await make(org, '/silent?m=1', { timeoutSeconds: 15 }),
      await make(org, '/silent?m=2', { timeoutSeconds: 15 }),
      await make(org, '/silent?m=3', { timeoutSeconds: 15 }),
    ];
    const path = join(directory, 'sigterm-timeout');
    const worker = startChild([org.orgId], {
      ...childEnv(path, 20_000),
      MONITOR_CHECK_CONCURRENCY: '1',
    });

    await waitFor('/silent to have a request in flight', () =>
      endpoints.requests.some((r) => r.startsWith('/silent')) ? true : null,
    );
    // Let the tick finish queueing before the signal.
    await waitFor(
      'the monitor tick to complete',
      () => readHeartbeat(path)?.loops.monitor?.lastCompletedAt != null,
    );
    worker.child.kill('SIGTERM');

    assert.equal(await exitWithin(worker, 60_000), 0, worker.output());
    const rows = await Promise.all(ids.map((id) => results(org.orgId, id)));
    assert.deepEqual(rows.map((r) => r.length).sort(), [0, 0, 1]);
    const recorded = rows.flat()[0];
    assert.equal(recorded.status, 'failure');
    assert.equal(recorded.error_code, 'timeout');
    const output = worker.output();
    assert.match(output, /checks not started; worker is shutting down/);
    assert.doesNotMatch(output, /"level":50/);
  });

  it('finishes and records a check in flight when SIGTERM arrives', async () => {
    const org = await newOrg();
    endpoints.reset();
    const monitorId = await make(org, '/hold?delay=1500');
    const path = join(directory, 'in-flight');
    const worker = startChild([org.orgId], childEnv(path, 20_000));

    await waitFor('/hold to have a request in flight', () =>
      endpoints.peakInFlight() >= 1 ? true : null,
    );
    worker.child.kill('SIGTERM');

    assert.equal(await exitWithin(worker, 20_000), 0, worker.output());
    const output = worker.output();
    assert.doesNotMatch(output, /closing the app failed/);
    assert.doesNotMatch(output, /closing the database connection failed/);
    const rows = await results(org.orgId, monitorId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'success');
    assert.equal(
      endpoints.requests.filter((r) => r.startsWith('/hold')).length,
      1,
    );
  });

  it('drops checks still queued on SIGTERM and finishes the one running', async () => {
    const org = await newOrg();
    endpoints.reset();
    const ids = [
      await make(org, '/hold?delay=1500&m=q1'),
      await make(org, '/hold?delay=1500&m=q2'),
      await make(org, '/hold?delay=1500&m=q3'),
    ];
    const path = join(directory, 'queued');
    const worker = startChild([org.orgId], {
      ...childEnv(path, 20_000),
      MONITOR_CHECK_CONCURRENCY: '1',
    });

    await waitFor('/hold to have a request in flight', () =>
      endpoints.peakInFlight() >= 1 ? true : null,
    );
    worker.child.kill('SIGTERM');

    assert.equal(await exitWithin(worker, 20_000), 0, worker.output());
    assert.equal(
      endpoints.requests.filter((r) => r.startsWith('/hold')).length,
      1,
    );
    const rows = await Promise.all(ids.map((id) => results(org.orgId, id)));
    assert.deepEqual(rows.map((r) => r.length).sort(), [0, 0, 1]);
    assert.equal(rows.flat()[0].status, 'success');
    const output = worker.output();
    assert.match(output, /checks not started; worker is shutting down/);
    assert.doesNotMatch(output, /monitor pass failed/);
  });

  it('runs the monitor loop on its own interval', async () => {
    const path = join(directory, 'monitor-interval');
    const org = await newOrg();
    const worker = startChild([org.orgId], {
      ...childEnv(path, 120_000),
      WORKER_MAINTENANCE_INTERVAL_MS: '60000',
      WORKER_MONITOR_INTERVAL_MS: '1000',
    });
    const maintenance = await waitFor('both loops to complete', () => {
      const loops = readHeartbeat(path)?.loops;
      return loops?.monitor?.lastCompletedAt != null &&
        loops.maintenance?.lastCompletedAt != null
        ? loops.maintenance.lastCompletedAt
        : null;
    });
    const seen = new Set<string>();
    await waitFor('two further monitor completions', () => {
      const loops = readHeartbeat(path)?.loops;
      assert.equal(loops?.maintenance?.lastCompletedAt, maintenance);
      const completed = loops?.monitor?.lastCompletedAt;
      if (completed) seen.add(completed);
      return seen.size >= 3;
    });
    worker.child.kill('SIGTERM');
    assert.equal(await exitWithin(worker, 20_000), 0, worker.output());
  });

  it('rewrites the heartbeat on its own timer', async () => {
    const path = join(directory, 'heartbeat-timer');
    const org = await newOrg();
    const worker = startChild([org.orgId], {
      ...childEnv(path, 120_000),
      WORKER_MAINTENANCE_INTERVAL_MS: '60000',
      WORKER_MONITOR_INTERVAL_MS: '60000',
    });
    const before = await waitFor('both loops to complete', () => {
      const record = readHeartbeat(path);
      return record?.loops.monitor?.lastCompletedAt != null &&
        record.loops.maintenance?.lastCompletedAt != null
        ? record
        : null;
    });
    await waitFor(
      'the heartbeat to be rewritten',
      () => {
        const record = readHeartbeat(path);
        if (record === null || record.writtenAt === before.writtenAt) {
          return null;
        }
        for (const name of ['maintenance', 'monitor'] as const) {
          assert.equal(
            record.loops[name]?.lastStartedAt,
            before.loops[name]?.lastStartedAt,
          );
          assert.equal(
            record.loops[name]?.lastCompletedAt,
            before.loops[name]?.lastCompletedAt,
          );
        }
        return true;
      },
      30_000,
    );
    worker.child.kill('SIGTERM');
    assert.equal(await exitWithin(worker, 20_000), 0, worker.output());
  });

  it('refuses to start a worker with no organizations', async () => {
    const worker = startChild(
      [],
      childEnv(join(directory, 'unscoped'), 20_000),
    );
    assert.equal(await exitWithin(worker, 20_000), 1, worker.output());
    assert.match(worker.output(), /refusing to start an unscoped worker/);
  });

  it('rejects when every organization fails, and the loop does not complete', async () => {
    capturedLogs.length = 0;
    await assert.rejects(
      runMonitorPass(app, capturingLogger, { orgIds: [BAD_ORG_ID] }),
      (error: Error) => {
        assert.equal(error.message, 'every organization failed (1)');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    const logged = capturedLogs.find(
      (entry) => entry.msg === 'monitor pass failed for organization',
    );
    assert.ok(logged);
    assert.equal((logged.obj as { orgId: string }).orgId, BAD_ORG_ID);
    assert.ok((logged.obj as { err: unknown }).err instanceof Error);

    const path = join(directory, 'all-fail');
    const health = createWorkerHealth({
      path,
      loops: ['monitor'],
      logger: quietLogger,
    });
    health.write();
    const loop = startLoop({
      name: 'monitor',
      pass: () =>
        runMonitorPass(app, capturingLogger, { orgIds: [BAD_ORG_ID] }),
      intervalMs: 60_000,
      health,
      logger: quietLogger,
    });
    await loop.inFlight?.catch(() => undefined);
    loop.stop();
    const loopHealth = readHeartbeat(path)?.loops.monitor;
    assert.ok(loopHealth?.lastStartedAt);
    assert.equal(loopHealth.lastCompletedAt, null);
  });

  it('rejects as stalled when every record fails for the overdue window', async () => {
    checkRegistry.reset();
    const org = await newOrg();
    await make(org, '/ok');
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: () => Promise<never>;
    };
    const original = repo.append;
    repo.append = () => Promise.reject(new Error('inserts refused'));
    const overdueMs = 4_000;
    try {
      const tick = () =>
        runMonitorPass(app, capturingLogger, {
          orgIds: [org.orgId],
          overdueMs,
        });
      // Well inside the window: the failure is pending but not yet a stall.
      await tick();
      await checkRegistry.drain();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await tick();
      await checkRegistry.drain();
      // Well past it.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await assert.rejects(tick(), /monitor checks stalled/);
      await checkRegistry.drain();
    } finally {
      repo.append = original;
      checkRegistry.reset();
    }
  });

  it('clears a pending failure when a tick finds nothing due', async () => {
    checkRegistry.reset();
    const org = await newOrg();
    const monitorId = await make(org, '/ok');
    const repo = app.diContainer.resolve('checkResultRepository' as never) as {
      append: () => Promise<never>;
    };
    const original = repo.append;
    repo.append = () => Promise.reject(new Error('inserts refused'));
    const overdueMs = 1_500;
    const tick = (orgIds: string[]) =>
      runMonitorPass(app, quietLogger, { orgIds, overdueMs });
    try {
      await tick([org.orgId]);
      await checkRegistry.drain();
    } finally {
      repo.append = original;
    }
    await updateMonitor(app, org.cookie, monitorId, { enabled: false });
    await new Promise((resolve) => setTimeout(resolve, overdueMs + 500));

    // With a listing failing too, the tick does not count as idle: stalled.
    await assert.rejects(
      tick([org.orgId, BAD_ORG_ID]),
      /monitor checks stalled/,
    );
    // Nothing due and nothing registered: the failure is moot.
    await tick([org.orgId]);
    await tick([org.orgId]);
  });

  it('resolves when only some organizations fail, and still records the good one', async () => {
    const org = await newOrg();
    const monitorId = await make(org, '/ok');
    await runMonitorPass(app, quietLogger, {
      orgIds: [org.orgId, BAD_ORG_ID],
    });
    await checkRegistry.drain();
    assert.equal((await results(org.orgId, monitorId)).length, 1);
  });

  it('moves the service status when a real check fails', async () => {
    const org = await newOrg();
    await make(org, '/error', { failureThreshold: 1 });
    await runMonitorPass(app, quietLogger, { orgIds: [org.orgId] });
    await checkRegistry.drain();
    await app.eventBus.drain();

    const [row] = await withTenantTransaction(
      org.orgId,
      ({ sql: tx }) =>
        tx<{ last_known_status: string }[]>`
          select last_known_status from services where id = ${org.serviceId}
        `,
    );
    assert.equal(row.last_known_status, 'major_outage');
  });

  it('rejects and runs no command when tenant discovery fails', async () => {
    // Last in the file: it closes the pool, so this file's rows go first.
    await deleteOrgs();
    await closeDbConnection();
    capturedLogs.length = 0;
    const stubApp = {
      get commandBus(): never {
        throw new Error('discovery failure must not reach the command bus');
      },
    } as unknown as Parameters<typeof runMonitorPass>[0];
    await assert.rejects(
      runMonitorPass(stubApp, capturingLogger),
      /tenant discovery failed/,
    );
    assert.ok(
      capturedLogs.some(
        (entry) => entry.msg === 'tenant discovery failed; skipping this pass',
      ),
    );
  });
});
