import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql, { closeDbConnection } from '@/shared/db/postgres';
import { createWorkerHealth } from '@/worker-health';
import { closeWorker, runWorkerPass, startLoop } from './worker';

/**
 * Story 9.10: the healthcheck reports completed passes, not a turning timer.
 * The loop is the real one with an injected pass; the verdict comes from the
 * real healthcheck, spawned. The child's limits are the smallest the settings
 * allow (an interval of at least 1 s), so every wait is a few seconds, and
 * each is at least 2 s clear of its threshold because this machine's clock
 * steps back by up to 1.4 s.
 *
 * Epic 9 retro item 2: the real runWorkerPass is driven too, scoped to the
 * test's own organizations, so a pass that did no work is shown to fail the
 * healthcheck, and closeWorker is shown to end the pool when app.close() fails.
 */

const REPO_ROOT = join(__dirname, '..');
const OVERDUE_MS = 20_000;
const CHILD_INTERVAL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const quietLogger = {
  warn() {},
  error() {},
  info() {},
} as unknown as FastifyBaseLogger;

const capturedErrors: string[] = [];
const capturingLogger = {
  warn() {},
  info() {},
  error(_obj: unknown, msg?: string) {
    capturedErrors.push(String(msg));
  },
} as unknown as FastifyBaseLogger;

const directory = mkdtempSync(join(tmpdir(), 'watchdog-health-'));
after(async () => {
  rmSync(directory, { recursive: true, force: true });
  // Also when the shutdown describe is filtered out. Both closes are idempotent.
  await (await appPromise).close().catch(() => undefined);
  await closeDbConnection();
});

function runHealthcheck(path: string, overrides: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/healthcheck.ts'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            WORKER_HEARTBEAT_PATH: path,
            WORKER_PASS_OVERDUE_MS: String(OVERDUE_MS),
            WORKER_MAINTENANCE_INTERVAL_MS: String(CHILD_INTERVAL_MS),
            ...overrides,
          },
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`healthcheck did not exit:\n${output}`));
      }, 60_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    },
  );
}

function setup(name: string) {
  const path = join(directory, name);
  const health = createWorkerHealth({
    path,
    loops: ['maintenance'],
    logger: quietLogger,
  });
  health.write();
  return { path, health };
}

const appPromise = buildApp({ logger: false }).then(async (built) => {
  // Handlers register on ready, as the worker does before its first pass.
  await built.ready();
  return built;
});
const BAD_ORG_ID = 'not a valid id!';
const MISSING_ORG_ID = 'a'.repeat(32);

describe(
  'Worker health reports completed passes',
  { concurrency: true },
  () => {
    it('passes while passes complete, once boot is older than the threshold', async () => {
      const { path, health } = setup('normal');
      const loop = startLoop({
        name: 'maintenance',
        pass: async () => {},
        intervalMs: 100,
        health,
        logger: quietLogger,
      });
      await sleep(OVERDUE_MS + 2_200);
      const result = await runHealthcheck(path);
      loop.stop();
      await loop.inFlight;
      assert.equal(result.code, 0, result.output);
    });

    it('passes while a slow pass is in flight', async () => {
      const { path, health } = setup('slow');
      const loop = startLoop({
        name: 'maintenance',
        pass: async () => {
          await sleep(5_000);
        },
        intervalMs: 100,
        health,
        logger: quietLogger,
      });
      try {
        await sleep(OVERDUE_MS + 2_200);
        // The pass is longer than the child's interval and still running.
        while (!loop.inFlight) {
          await sleep(10);
        }
        const result = await runHealthcheck(path);
        assert.equal(result.code, 0, result.output);
      } finally {
        loop.stop();
        await loop.inFlight;
      }
    });

    it('fails a pass that never settles while the timer keeps writing', async () => {
      const { path, health } = setup('stuck');
      let passes = 0;
      const loop = startLoop({
        name: 'maintenance',
        pass: () => {
          passes += 1;
          return passes === 1 ? Promise.resolve() : new Promise<void>(() => {});
        },
        intervalMs: 100,
        health,
        logger: quietLogger,
      });
      const timer = setInterval(() => health.write(), 200);
      try {
        await sleep(OVERDUE_MS + 2_200);
        const first = readFileSync(path, 'utf8');
        await sleep(500);
        assert.notEqual(
          readFileSync(path, 'utf8'),
          first,
          'the record keeps being written',
        );
        assert.ok(loop.inFlight, 'the pass is still gated');
        const result = await runHealthcheck(path);
        assert.equal(result.code, 1, result.output);
      } finally {
        clearInterval(timer);
        loop.stop();
      }
    });

    it('passes just after boot, before any pass has completed', async () => {
      const { path, health } = setup('just-started');
      const loop = startLoop({
        name: 'maintenance',
        pass: () => new Promise<void>(() => {}),
        intervalMs: 100,
        health,
        logger: quietLogger,
      });
      try {
        const result = await runHealthcheck(path);
        assert.equal(result.code, 0, result.output);
      } finally {
        loop.stop();
      }
    });

    it('fails when every pass rejects, without an unhandled rejection', async () => {
      const { path, health } = setup('rejecting');
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      const loop = startLoop({
        name: 'maintenance',
        pass: () => Promise.reject(new Error('x')),
        intervalMs: 100,
        health,
        logger: quietLogger,
      });
      try {
        await sleep(OVERDUE_MS + 2_200);
        const result = await runHealthcheck(path);
        assert.equal(result.code, 1, result.output);
        assert.deepEqual(unhandled, []);
      } finally {
        loop.stop();
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('fails when every organization fails', async () => {
      const app = await appPromise;
      const { path, health } = setup('every-org-fails');
      const loop = startLoop({
        name: 'maintenance',
        pass: () => runWorkerPass(app, quietLogger, { orgIds: [BAD_ORG_ID] }),
        intervalMs: 1_000,
        health,
        logger: quietLogger,
      });
      try {
        await sleep(OVERDUE_MS + 2_200);
        const result = await runHealthcheck(path);
        assert.equal(result.code, 1, result.output);
        assert.match(
          result.output,
          /loop maintenance has not completed a pass/,
        );
      } finally {
        loop.stop();
        await loop.inFlight?.catch(() => undefined);
      }
    });

    it('passes when some organizations fail and others succeed', async () => {
      const app = await appPromise;
      const { path, health } = setup('some-orgs-fail');
      const loop = startLoop({
        name: 'maintenance',
        pass: () =>
          runWorkerPass(app, quietLogger, {
            orgIds: [BAD_ORG_ID, MISSING_ORG_ID],
          }),
        intervalMs: 1_000,
        health,
        logger: quietLogger,
      });
      try {
        await sleep(OVERDUE_MS + 2_200);
        const result = await runHealthcheck(path);
        assert.equal(result.code, 0, result.output);
      } finally {
        loop.stop();
        await loop.inFlight?.catch(() => undefined);
      }
    });

    it('passes when there are no organizations', async () => {
      const app = await appPromise;
      const { path, health } = setup('no-orgs');
      const loop = startLoop({
        name: 'maintenance',
        pass: () => runWorkerPass(app, quietLogger, { orgIds: [] }),
        intervalMs: 1_000,
        health,
        logger: quietLogger,
      });
      try {
        await sleep(OVERDUE_MS + 2_200);
        const result = await runHealthcheck(path);
        assert.equal(result.code, 0, result.output);
      } finally {
        loop.stop();
        await loop.inFlight?.catch(() => undefined);
      }
    });

    it('refuses a threshold not greater than the interval', async () => {
      const { path } = setup('misconfigured');
      const result = await runHealthcheck(path, {
        WORKER_PASS_OVERDUE_MS: '1000',
        WORKER_MAINTENANCE_INTERVAL_MS: '1000',
      });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /WORKER_PASS_OVERDUE_MS/);
      assert.match(result.output, /WORKER_MAINTENANCE_INTERVAL_MS/);
    });

    it('fails when the timer is dead', async () => {
      const { path } = setup('timer-dead');
      await sleep(3_200);
      const result = await runHealthcheck(path, {
        WORKER_HEARTBEAT_MAX_AGE_MS: '1000',
      });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /heartbeat/);
    });

    it('refuses a loop that is not registered with the health record', () => {
      const { health } = setup('unregistered');
      assert.throws(
        () =>
          startLoop({
            name: 'monitor',
            pass: async () => {},
            intervalMs: 100,
            health,
            logger: quietLogger,
          }),
        /monitor/,
      );
    });
  },
);

describe('Worker shutdown and a dead database', () => {
  before(async () => {
    const app = await appPromise;
    await app.close();
  });
  after(async () => {
    await closeDbConnection();
  });

  it('closeWorker logs a failed app.close() and still ends the pool', async () => {
    const failure = new Error('close failed');
    const logged: unknown[] = [];
    const logger = {
      warn() {},
      info() {},
      error(obj: unknown) {
        logged.push(obj);
      },
    } as unknown as FastifyBaseLogger;
    await closeWorker(
      {
        close: () => Promise.reject(failure),
      } as unknown as Parameters<typeof closeWorker>[0],
      logger,
    );
    assert.equal((logged[0] as { err: unknown }).err, failure);
    await assert.rejects(sql`select 1`);
  });

  it('fails the healthcheck when tenant discovery fails', async () => {
    await closeDbConnection();
    await assert.rejects(sql`select 1`);
    const stubApp = {
      get commandBus(): never {
        throw new Error('discovery failure must not reach the command bus');
      },
    } as unknown as Parameters<typeof runWorkerPass>[0];
    const { path, health } = setup('discovery-fails');
    const loop = startLoop({
      name: 'maintenance',
      pass: () => runWorkerPass(stubApp, capturingLogger),
      intervalMs: 1_000,
      health,
      logger: quietLogger,
    });
    try {
      await sleep(OVERDUE_MS + 2_200);
      const result = await runHealthcheck(path);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /loop maintenance has not completed a pass/);
      assert.ok(
        capturedErrors.includes('tenant discovery failed; skipping this pass'),
        capturedErrors.join(' | '),
      );
    } finally {
      loop.stop();
      await loop.inFlight?.catch(() => undefined);
    }
  });
});
