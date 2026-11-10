import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Closes story 6.9's deferred entry: each retention setting reaches its own
 * field through the real loader. The two are plain integers of similar size,
 * so swapping them in `env.ts` would pass every other suite, because the prune
 * suite ages its rows from the mapped values.
 *
 * An integration test although it needs no database: `env.ts` validates the
 * whole environment at import, and CI's unit job has no `.env`. Like the other
 * `src/config` suites, it reads the config in a spawned process, so the values
 * set here cannot leak into, or depend on, anything else this process loaded.
 * dotenv does not override a variable already set, so they win over `.env`.
 */

const REPO_ROOT = join(__dirname, '..', '..');

function readRetention() {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          "const c = require('./src/config/env.ts').default; console.log('RETENTION=' + JSON.stringify({ retentionDays: c.notification.retentionDays, pendingGraceDays: c.subscribe.pendingGraceDays }))",
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NOTIFICATION_RETENTION_DAYS: '11',
            SUBSCRIBER_PENDING_GRACE_DAYS: '22',
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
        reject(new Error(`process did not exit:\n${output}`));
      }, 30_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    },
  );
}

describe('story 6.9: the retention settings', () => {
  it('maps NOTIFICATION_RETENTION_DAYS and SUBSCRIBER_PENDING_GRACE_DAYS to their own fields', async () => {
    const result = await readRetention();
    assert.equal(result.code, 0, result.output);
    const line = result.output
      .split('\n')
      .find((l) => l.startsWith('RETENTION='));
    assert.ok(line, result.output);
    assert.deepEqual(JSON.parse((line as string).slice('RETENTION='.length)), {
      retentionDays: 11,
      pendingGraceDays: 22,
    });
  });
});
