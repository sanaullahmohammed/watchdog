import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * The worker and the seed no longer force exit, so a process that builds an
 * app, closes it and closes postgres.js must end by itself.
 */
describe('A closed app lets its process exit', () => {
  it('exits 0 within 60 seconds without a forced exit', async () => {
    const { code, output, closedAt, exitedAt } = await new Promise<{
      code: number | null;
      output: string;
      closedAt: number | undefined;
      exitedAt: number;
    }>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/server/auth/close-and-exit.fixture.ts'],
        { cwd: REPO_ROOT, env: process.env },
      );
      let output = '';
      let closedAt: number | undefined;
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (closedAt === undefined && output.includes('closed')) {
          closedAt = Date.now();
        }
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child did not exit within 60 s:\n${output}`));
      }, 60_000);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolvePromise({
          code: exitCode,
          output,
          closedAt,
          exitedAt: Date.now(),
        });
      });
    });
    assert.equal(code, 0, output);
    assert.ok(
      closedAt !== undefined,
      `the child never reported closing:\n${output}`,
    );
    // An unreleased pool would hold the process for pg's 10 s idle timeout.
    assert.ok(
      exitedAt - closedAt < 5_000,
      `exit came ${exitedAt - closedAt} ms after closing`,
    );
  });
});
