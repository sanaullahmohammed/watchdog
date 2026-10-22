import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Story 6.3: `env.ts` really runs `assertSubscribeLimits`. A spawned process,
 * as allowed-cidrs.integration.test.ts does.
 */

const REPO_ROOT = join(__dirname, '..', '..');

function run(extra: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/index.ts', 'api'],
        { cwd: REPO_ROOT, env: { ...process.env, ...extra } },
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

describe('the subscribe rate limit boot check', () => {
  it('stops api at boot when the max exceeds the public max', async () => {
    const result = await run({
      PUBLIC_RATE_LIMIT_MAX: '10',
      SUBSCRIBE_RATE_LIMIT_MAX: '11',
    });
    assert.notEqual(result.code, 0, result.output);
    assert.match(
      result.output,
      /SUBSCRIBE_RATE_LIMIT_MAX.*PUBLIC_RATE_LIMIT_MAX/,
    );
  });

  it('stops api at boot when the retry maximum delay is below the base (story 6.7)', async () => {
    const result = await run({
      NOTIFICATION_RETRY_BASE_SECONDS: '120',
      NOTIFICATION_RETRY_MAX_DELAY_SECONDS: '119',
    });
    assert.notEqual(result.code, 0, result.output);
    assert.match(
      result.output,
      /NOTIFICATION_RETRY_MAX_DELAY_SECONDS.*NOTIFICATION_RETRY_BASE_SECONDS/,
    );
  });
});
