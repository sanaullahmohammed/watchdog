import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { authPool } from './auth';

/**
 * Story 9.9. One ordered scenario: a pool cannot reopen within its process, so
 * each step depends on the one before. The api and worker entrypoints rely on
 * this contract (ARCHITECTURE.md section 7).
 */

const ORIGIN = 'http://localhost:3000';
const suffix = randomBytes(4).toString('hex');
const email = `pool-${suffix}@example.test`;
const password = 'correct-horse-battery-staple';

describe('Better Auth pool shutdown', () => {
  after(async () => {
    await sql`delete from "user" where "email" = ${email}`;
    await sql.end({ timeout: 5 });
  });

  it('ends the pool after the last app closes and the bus drains', async () => {
    const appA = await buildApp({ logger: false });
    const appB = await buildApp({ logger: false });
    try {
      await appA.ready();
      await appB.ready();

      const signUp = await appA.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: ORIGIN },
        payload: { email, password, name: 'Pool Test' },
      });
      assert.equal(signUp.statusCode, 200, signUp.body);

      await appB.close();
      const signIn = await appA.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: ORIGIN },
        payload: { email, password },
      });
      assert.equal(signIn.statusCode, 200, signIn.body);

      let handlerSawOpenPool = false;
      appA.eventBus.on('test.auth-pool-shutdown', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await authPool.query('select 1');
        handlerSawOpenPool = true;
      });
      appA.eventBus.emit({
        type: 'test.auth-pool-shutdown',
        payload: {},
      } as never);

      await appA.close();
      assert.equal(handlerSawOpenPool, true);
      assert.equal((authPool as unknown as { ended: boolean }).ended, true);
      assert.equal(authPool.totalCount, 0);
    } finally {
      await Promise.allSettled([appA.close(), appB.close()]);
    }

    await assert.rejects(
      () => buildApp({ logger: false }),
      /Better Auth pool has ended/,
    );
  });
});
