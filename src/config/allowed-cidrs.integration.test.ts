import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Closes 5.1's deferred entry: the setting reaches `config.monitor.allowedCidrs`
 * through the real loader, and an invalid entry stops both entrypoints at boot.
 * Each case is a spawned process, as the worker-health suite does.
 */

const REPO_ROOT = join(__dirname, '..', '..');

function run(args: string[], allowedCidrs: string) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, MONITOR_ALLOWED_CIDRS: allowedCidrs },
      });
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

describe('MONITOR_ALLOWED_CIDRS', () => {
  it('reaches config.monitor.allowedCidrs', async () => {
    const result = await run(
      [
        '-e',
        "console.log('CIDRS=' + JSON.stringify(require('./src/config/env.ts').default.monitor.allowedCidrs))",
      ],
      '127.0.0.0/8, fd00::/8',
    );
    assert.equal(result.code, 0, result.output);
    const line = result.output.split('\n').find((l) => l.startsWith('CIDRS='));
    assert.ok(line, result.output);
    assert.deepEqual(JSON.parse((line as string).slice('CIDRS='.length)), [
      { address: '127.0.0.0', prefix: 8, family: 'ipv4' },
      { address: 'fd00::', prefix: 8, family: 'ipv6' },
    ]);
  });

  for (const entrypoint of ['api', 'worker']) {
    it(`stops ${entrypoint} at boot on an invalid entry`, async () => {
      const result = await run(
        ['src/index.ts', entrypoint],
        '10.0.0.0/8,bogus',
      );
      assert.notEqual(result.code, 0, result.output);
      assert.match(
        result.output,
        /MONITOR_ALLOWED_CIDRS has an invalid entry "bogus"/,
      );
    });
  }
});
