import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import type * as WorkerModule from '@/worker';

/**
 * Test-only seam: starts the real worker, scoped to the given organizations, in
 * a child process, so a test can drive its healthcheck and its SIGTERM. Run as
 * main it takes the organization ids from argv and refuses none, so no test can
 * start an unscoped worker. `@/worker` is required inside the main branch, so
 * importing this file for `spawnScopedWorker` loads no configuration.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..');

export interface ScopedWorker {
  readonly child: ChildProcess;
  /** Everything the child wrote to stdout and stderr so far. */
  readonly output: () => string;
  /** Resolves with the exit code once the child has exited. */
  readonly exit: Promise<number | null>;
}

export function spawnScopedWorker(
  orgIds: readonly string[],
  env: NodeJS.ProcessEnv,
): ScopedWorker {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', __filename, ...orgIds],
    { cwd: REPO_ROOT, env },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  // 'close', not 'exit': Node emits it after the stdio streams end, so the
  // output is complete when a test reads it.
  const exit = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (error) => {
      output += `${error.stack ?? String(error)}\n`;
      resolve(null);
    });
  });
  return { child, output: () => output, exit };
}

/**
 * Runs `src/healthcheck.ts` with exactly this env and resolves with its exit
 * code and output. The env must pass the config cross-checks, because the
 * healthcheck imports `@/config`.
 */
export function runHealthcheck(env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/healthcheck.ts'],
        { cwd: REPO_ROOT, env },
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
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(`healthcheck failed to run: ${error.stack}\n${output}`),
        );
      });
    },
  );
}

if (require.main === module) {
  const orgIds = process.argv.slice(2);
  if (orgIds.length === 0) {
    process.stderr.write('refusing to start an unscoped worker\n');
    process.exit(1);
  }
  try {
    // A require inside the main branch: loading config is deferred to here.
    const { startWorker } = require('@/worker') as typeof WorkerModule;
    startWorker({ orgIds }).catch(fail);
  } catch (error) {
    fail(error);
  }
}

function fail(error: unknown): never {
  process.stderr.write(
    `${error instanceof Error && error.stack ? error.stack : String(error)}\n`,
  );
  process.exit(1);
}
