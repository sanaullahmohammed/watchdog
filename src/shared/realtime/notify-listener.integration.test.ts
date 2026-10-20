import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import config from '@/config/env';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { sqlDebugOption } from '@/shared/db/sql-debug';
import {
  type NotifyListener,
  startNotifyListener,
} from '@/shared/realtime/notify-listener';
import type { RealtimeEvent } from '@/shared/realtime/realtime-event';
import {
  createRealtimeHub,
  type RealtimeHub,
  type RealtimeLogger,
  type RealtimeSignal,
} from '@/shared/realtime/realtime-hub';
import { notifyRaw, subscribeForOrg } from '@/shared/testing/notifications';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';
import {
  type ScopedWorker,
  spawnScopedWorker,
} from '@/shared/testing/worker-process';

/**
 * Story 4.4: the api listens on `watchdog_events` and fans each notification
 * out to one organization's subscribers.
 *
 * Every integration file bridges onto the same channel, so subscribers are
 * kept to this file's organizations, and the malformed rows mark each payload
 * so their `warn` lines are told from anyone else's.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const tag = `lsn-${randomBytes(4).toString('hex')}`;
const LISTENER_NAME = `watchdog-listener:${process.pid}`;
const WAIT_MS = 15_000;
const directory = mkdtempSync(join(tmpdir(), 'watchdog-listener-'));

let app: FastifyInstance;
let cookieA = '';
let userAId = '';
let userBId = '';
let userCId = '';
let orgAId = '';
let orgBId = '';
let orgCId = '';
const children: ScopedWorker[] = [];
const apis: ChildProcess[] = [];

function realtimeEvent(
  orgId: string,
  eventName: string,
  aggregateId: string = randomUUID(),
): RealtimeEvent {
  return {
    eventName,
    orgId,
    aggregateType: eventName.slice(0, eventName.indexOf('.')),
    aggregateId,
    occurredAt: new Date().toISOString(),
    version: 1,
  };
}

async function backendsNamed(name: string): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`
    select pid from pg_stat_activity where application_name = ${name}
  `;
  return rows.map(({ pid }) => pid);
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | false> | T | null | false,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Resolves on the first signal of `kind` the channel delivers for `orgId`. */
function nextSignal(
  hub: RealtimeHub,
  channel: 'admin' | 'public',
  orgId: string,
  kind: RealtimeSignal['kind'],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${kind} on ${channel} within ${WAIT_MS}ms`));
    }, WAIT_MS);
    const subscribe =
      channel === 'admin' ? hub.subscribeAdmin : hub.subscribePublic;
    const off = subscribe(orgId, (signal) => {
      if (signal.kind !== kind) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** A logger that records what it is given, for listeners started directly. */
function recordingLogger() {
  const warns: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const log: RealtimeLogger = {
    warn: (obj) => void warns.push(obj as Record<string, unknown>),
    error: (obj) => void errors.push(obj as Record<string, unknown>),
  };
  return { log, warns, errors };
}

/**
 * A listener and hub of the test's own, outside any app, so the logger it
 * writes to can be read. Named apart from `LISTENER_NAME`, which counts the
 * app's listener only.
 */
async function startOwnListener(log: RealtimeLogger) {
  const hub = createRealtimeHub(log);
  const listener: NotifyListener = await startNotifyListener({
    sql: postgres(config.db.url, {
      max: 1,
      connection: { application_name: `${tag}-direct` },
      ...sqlDebugOption(config.log.level, () => ({ debug() {} })),
    }),
    hub,
    log,
  });
  return { hub, listener };
}

describe('Story 4.4: listen in the api and fan out per organization', () => {
  before(async () => {
    app = await buildApp({ logger: false }, { listen: true });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, `${tag}-a`));
    ({ userId: userBId, orgId: orgBId } = await signUpWithOrg(app, `${tag}-b`));
    await app.eventBus.drain();
  });

  after(async () => {
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
    for (const api of apis) {
      if (api.exitCode === null && api.signalCode === null) {
        api.kill('SIGKILL');
      }
    }
    rmSync(directory, { recursive: true, force: true });
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId}, ${orgCId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId}, ${userCId})`;
    // Normally already closed by the last test.
    await app.close().catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  it('delivers to one organization only, and to its public subscribers only what is whitelisted', async () => {
    const a = subscribeForOrg(app.realtimeHub, orgAId);
    const b = subscribeForOrg(app.realtimeHub, orgBId);
    try {
      // Sent from the test's pool connection, not through the app's bus.
      const created = realtimeEvent(orgAId, 'service.created');
      const breached = realtimeEvent(orgAId, 'monitor.threshold_breached');
      await notifyRaw(JSON.stringify(created));
      await notifyRaw(JSON.stringify(breached));
      await a.settle();
      await b.settle();

      assert.deepEqual(a.admin, [
        { kind: 'event', event: created },
        { kind: 'event', event: breached },
      ]);
      assert.deepEqual(a.public, [{ kind: 'event', event: created }]);
      assert.deepEqual(b.admin, []);
      assert.deepEqual(b.public, []);
    } finally {
      a.close();
      b.close();
    }
  });

  it('drops a malformed notification with one warn each, and keeps listening', async () => {
    const { log, warns } = recordingLogger();
    const { hub, listener } = await startOwnListener(log);
    const subscriber = subscribeForOrg(hub, orgAId);
    try {
      const marker = () => `${tag}-${randomUUID()}`;
      const malformed = {
        'not JSON': (m: string) => `not json ${m}`,
        'unsupported version': (m: string) =>
          JSON.stringify({
            ...realtimeEvent(orgAId, 'service.created', m),
            version: 2,
          }),
        'not a bridged event': (m: string) =>
          JSON.stringify(realtimeEvent(orgAId, 'monitor.created', m)),
        'invalid orgId': (m: string) =>
          JSON.stringify(realtimeEvent('a b', 'service.created', m)),
        'not a JSON object': (m: string) =>
          JSON.stringify([realtimeEvent(orgAId, 'service.created', m)]),
        'missing a field': (m: string) =>
          JSON.stringify({
            ...realtimeEvent(orgAId, 'service.created'),
            aggregateId: 42,
            marker: m,
          }),
      };
      const markers: Array<[string, string]> = [];
      for (const [reason, payload] of Object.entries(malformed)) {
        const m = marker();
        markers.push([reason, m]);
        await notifyRaw(payload(m));
      }
      // Accepted, but only its six fields reach a subscriber.
      const valid = realtimeEvent(orgAId, 'incident.created');
      await notifyRaw(
        JSON.stringify({ ...valid, title: 'Checkout is failing' }),
      );
      await subscriber.settle();

      for (const [reason, m] of markers) {
        const mine = warns.filter((warn) => String(warn.payload).includes(m));
        assert.equal(mine.length, 1, `one warn for ${reason}`);
        assert.equal(mine[0].reason, reason);
      }
      assert.deepEqual(subscriber.admin, [{ kind: 'event', event: valid }]);
      assert.deepEqual(subscriber.public, [{ kind: 'event', event: valid }]);
    } finally {
      subscriber.close();
      await listener.close();
    }
  });

  it('keeps delivering past a subscriber that throws, and logs it once', async () => {
    const { log, errors } = recordingLogger();
    const { hub, listener } = await startOwnListener(log);
    const aggregateId = randomUUID();
    const failure = new Error(`${tag} subscriber threw`);
    const offThrowing = hub.subscribeAdmin(orgAId, (signal) => {
      if (signal.kind === 'event' && signal.event.aggregateId === aggregateId) {
        throw failure;
      }
    });
    const second = subscribeForOrg(hub, orgAId);
    try {
      const event = realtimeEvent(orgAId, 'incident.updated', aggregateId);
      await notifyRaw(JSON.stringify(event));
      await second.settle();

      assert.deepEqual(second.admin, [{ kind: 'event', event }]);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].err, failure);
    } finally {
      offThrowing();
      second.close();
      await listener.close();
    }
  });

  it('hears the app s own event once, through LISTEN only', async () => {
    const subscriber = subscribeForOrg(app.realtimeHub, orgAId);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/incidents',
        headers: { cookie: cookieA, origin: TEST_ORIGIN },
        payload: { title: 'Checkout is failing', impact: 'major' },
      });
      assert.equal(response.statusCode, 201, response.body);
      const { id } = JSON.parse(response.body) as { id: string };

      await subscriber.settle(app);

      const created = subscriber.admin.filter(
        (signal) =>
          signal.kind === 'event' &&
          signal.event.eventName === 'incident.created',
      );
      assert.equal(created.length, 1, 'incident.created arrives exactly once');
      assert.deepEqual(
        created.map(
          (signal) => signal.kind === 'event' && signal.event.aggregateId,
        ),
        [id],
      );
    } finally {
      subscriber.close();
    }
  });

  it('does not listen in the worker', async () => {
    const env = {
      ...process.env,
      LOG_LEVEL: 'info',
      WORKER_HEARTBEAT_PATH: join(directory, 'heartbeat'),
      WORKER_MAINTENANCE_INTERVAL_MS: '1000',
      WORKER_MONITOR_INTERVAL_MS: '1000',
      WORKER_PASS_OVERDUE_MS: '20000',
    };
    // An organization of its own, which nothing here subscribes to: what the
    // worker's passes announce for it cannot reach another test's lists.
    ({ userId: userCId, orgId: orgCId } = await signUpWithOrg(app, `${tag}-c`));
    const worker = spawnScopedWorker([orgCId], env);
    children.push(worker);

    await waitFor('the worker to be ready', () =>
      worker.output().includes('Worker is ready'),
    );
    assert.ok(worker.child.pid, 'the worker has a pid');

    assert.deepEqual(
      await backendsNamed(`watchdog-listener:${worker.child.pid}`),
      [],
      'the worker opened a LISTEN connection',
    );
    // Not vacuous: this file's listening app is found under its own pid.
    assert.equal((await backendsNamed(LISTENER_NAME)).length, 1);

    worker.child.kill('SIGTERM');
    const guard = setTimeout(() => worker.child.kill('SIGKILL'), WAIT_MS);
    try {
      assert.equal(await worker.exit, 0, worker.output());
    } finally {
      clearTimeout(guard);
    }
  });

  it('listens in the real api entrypoint, and lets go on SIGTERM', async () => {
    const api = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'api'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          // The application role, which passes the api's role guard.
          DATABASE_URL: config.db.url,
          HOST: '127.0.0.1',
          PORT: '0',
          LOG_LEVEL: 'info',
        },
      },
    );
    apis.push(api);
    let output = '';
    api.stdout.on('data', (chunk) => {
      output += chunk;
    });
    api.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exit = new Promise<number | null>((resolve) =>
      api.on('close', resolve),
    );

    await waitFor('the api to be ready', () =>
      output.includes('Server is ready'),
    );
    const name = `watchdog-listener:${api.pid}`;
    assert.equal((await backendsNamed(name)).length, 1, output);

    api.kill('SIGTERM');
    const guard = setTimeout(() => api.kill('SIGKILL'), 30_000);
    try {
      // By itself, after its shutdown steps: graceful-server exits with the
      // signal's number, 15 for SIGTERM. Killed by the guard, it would be null.
      assert.equal(await exit, 15, output);
    } finally {
      clearTimeout(guard);
    }
    await waitFor(
      'the api listener backend to leave pg_stat_activity',
      async () => (await backendsNamed(name)).length === 0,
    );
  });

  it('tells every subscriber to resync once after a re-listen', async () => {
    const a = subscribeForOrg(app.realtimeHub, orgAId);
    const b = subscribeForOrg(app.realtimeHub, orgBId);
    try {
      const [before] = await backendsNamed(LISTENER_NAME);
      assert.ok(before, 'the listener has a backend');

      const resynced = [
        nextSignal(app.realtimeHub, 'admin', orgAId, 'resync'),
        nextSignal(app.realtimeHub, 'public', orgAId, 'resync'),
        nextSignal(app.realtimeHub, 'admin', orgBId, 'resync'),
        nextSignal(app.realtimeHub, 'public', orgBId, 'resync'),
      ];
      const [{ terminated }] = await sql<{ terminated: boolean }[]>`
        select pg_terminate_backend(${before}::int) as terminated
      `;
      assert.equal(terminated, true);
      await Promise.all(resynced);

      // Through the new connection, which settles after the resync.
      await a.settle();
      await b.settle();
      for (const subscriber of [a, b]) {
        assert.deepEqual(subscriber.admin, [{ kind: 'resync' }]);
        assert.deepEqual(subscriber.public, [{ kind: 'resync' }]);
      }
      const after = await backendsNamed(LISTENER_NAME);
      assert.equal(after.length, 1);
      assert.notEqual(after[0], before);
    } finally {
      a.close();
      b.close();
    }
  });

  it('rejects buildApp and lets the process exit when the first listen fails', async () => {
    // A database that does not exist: the listen is refused at connect.
    const url = new URL(config.db.url);
    url.pathname = `/${tag.replace('-', '_')}_missing`;
    const script = `
      const { buildApp } = require('./src/server/build-app.ts');
      const { closeDbConnection } = require('./src/shared/db/postgres.ts');
      buildApp({ logger: false }, { listen: true }).then(
        () => { console.log('BUILT'); process.exitCode = 2; },
        (error) => { console.log('REJECTED ' + error.code); },
      ).finally(() => closeDbConnection());
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url.toString() },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    // Exiting by itself is the proof: a client left re-listening in the
    // background would hold the process open until this guard kills it.
    let killed = false;
    const guard = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, 30_000);
    const code = await new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    clearTimeout(guard);

    assert.equal(killed, false, `the process did not exit:\n${output}`);
    assert.equal(code, 0, output);
    assert.match(output, /REJECTED 3D000/);
  });

  // Last: closes the file's listening app.
  it('closes every subscriber, then the listener connection', async () => {
    const a = subscribeForOrg(app.realtimeHub, orgAId);
    const b = subscribeForOrg(app.realtimeHub, orgBId);
    assert.equal((await backendsNamed(LISTENER_NAME)).length, 1);

    await app.close();

    for (const subscriber of [a, b]) {
      assert.deepEqual(subscriber.admin, [{ kind: 'closed' }]);
      assert.deepEqual(subscriber.public, [{ kind: 'closed' }]);
    }
    await waitFor(
      'the listener backend to leave pg_stat_activity',
      async () => (await backendsNamed(LISTENER_NAME)).length === 0,
    );
  });
});
