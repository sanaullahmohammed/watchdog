import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { ownerDatabaseUrl } from '@/config/owner-env';
import sql from '@/shared/db/postgres';
import {
  assertTenantBoundRole,
  type DatabaseRole,
  roleRefusal,
  UnsafeDatabaseRoleError,
} from '@/shared/db/runtime-role';

/**
 * Epic 3 retrospective, action item 10 (R-14): `api` and `worker` refuse to
 * start as a role that row-level security does not bind. Proven against the
 * owner role DBMate migrates with, which in Compose and CI is the superuser,
 * so swapping the two URLs is exactly the mistake the guard exists for.
 */

const REPO_ROOT = join(__dirname, '../../..');

let owner: postgres.Sql;
let ownerRole: DatabaseRole;

/** The line an entrypoint logs when it refuses, parsed from its output. */
function fatalLine(output: string) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { level: number; msg: string })
    .find((entry) => entry.level === 60);
}

/**
 * Runs a real entrypoint as the owner and waits for it to exit. The child
 * inherits this environment, and its DATABASE_URL overrides `.env`'s, since
 * env-schema lays the process environment over the file.
 */
function startAsOwner(
  entrypoint: 'api' | 'worker',
  env: Record<string, string>,
) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/index.ts', entrypoint],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: ownerDatabaseUrl(), ...env },
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
        reject(new Error(`${entrypoint} did not exit:\n${output}`));
      }, 60_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    },
  );
}

describe('The boot guard on the database role (retrospective R-14)', () => {
  before(() => {
    owner = postgres(ownerDatabaseUrl(), { max: 1 });
  });

  after(async () => {
    await owner.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it('proves against a role that really is exempt', async () => {
    // Guards the guard: were the owner an ordinary role here, every refusal
    // below would be vacuous. Compose's and CI's superuser also has BYPASSRLS.
    [ownerRole] = await owner<DatabaseRole[]>`
      select rolname, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user
    `;
    assert.equal(
      ownerRole.rolsuper,
      true,
      'the owner connection is a superuser',
    );
  });

  it('lets the application role through', async () => {
    await assertTenantBoundRole(sql);
  });

  it('refuses the owner, naming it', async () => {
    await assert.rejects(assertTenantBoundRole(owner), (error: Error) => {
      assert.ok(error instanceof UnsafeDatabaseRoleError);
      assert.equal(error.message, roleRefusal(ownerRole));
      assert.match(error.message, /connects as "\w+", which is a superuser/);
      return true;
    });
  });

  it('keeps the api from starting as the owner', async () => {
    const { code, output } = await startAsOwner('api', { PORT: '0' });

    assert.equal(code, 1, output);
    // Its own refusal, logged fatal, not some other failure to boot.
    assert.equal(fatalLine(output)?.msg, roleRefusal(ownerRole), output);
    assert.doesNotMatch(output, /Server listening/);
  });

  it('keeps the worker from doing any work as the owner', async () => {
    const heartbeat = join(tmpdir(), `watchdog-guard-${process.pid}`);
    rmSync(heartbeat, { force: true });

    const { code, output } = await startAsOwner('worker', {
      WORKER_HEARTBEAT_PATH: heartbeat,
    });

    assert.equal(code, 1, output);
    assert.equal(fatalLine(output)?.msg, roleRefusal(ownerRole), output);
    assert.equal(existsSync(heartbeat), false, 'no heartbeat was written');
  });
});
