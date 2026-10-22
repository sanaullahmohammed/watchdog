import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Story 6.4: boot fails without a usable `NOTIFICATION_LINK_SECRET`, naming
 * the variable and quoting nothing. A spawned process, as
 * subscribe-limits.integration.test.ts does.
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

describe('the NOTIFICATION_LINK_SECRET boot check', () => {
  it('stops api at boot when the secret is empty', async () => {
    const result = await run({ NOTIFICATION_LINK_SECRET: '' });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /NOTIFICATION_LINK_SECRET/);
  });

  it('stops api at boot when the secret is 31 characters, quoting nothing', async () => {
    const marker = 'SECRETMARKERxyz';
    const secret = `${marker}${'k'.repeat(31 - marker.length)}`;
    assert.equal(secret.length, 31);
    const result = await run({ NOTIFICATION_LINK_SECRET: secret });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /NOTIFICATION_LINK_SECRET/);
    assert.ok(!result.output.includes(marker), 'the secret was quoted');
  });
});
