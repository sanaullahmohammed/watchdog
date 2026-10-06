import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { isRationedGraphqlRequest } from '@/server/anonymous-graphql';

const warnings: unknown[] = [];
type Req = Pick<FastifyRequest, 'routeOptions' | 'headers' | 'log'>;
const make = (url: string, cookie?: string): Req =>
  ({
    routeOptions: { url },
    headers: cookie ? { cookie } : {},
    log: { warn: (...args: unknown[]) => warnings.push(args) },
  }) as unknown as Req;

describe('isRationedGraphqlRequest', () => {
  it('does not ration another route', async () => {
    assert.equal(
      await isRationedGraphqlRequest(make('/status/:orgSlug'), async () => {
        throw new Error('another route must not look up a session');
      }),
      false,
    );
  });

  it('rations a request with no cookie, without a lookup', async () => {
    let called = false;
    const result = await isRationedGraphqlRequest(
      make('/graphql'),
      async () => {
        called = true;
        return null;
      },
    );
    assert.equal(result, true);
    assert.equal(called, false);
  });

  it('rations a cookie that resolves to no session', async () => {
    assert.equal(
      await isRationedGraphqlRequest(
        make('/graphql', 'junk=cookie'),
        async () => null,
      ),
      true,
    );
  });

  it('does not ration a valid session', async () => {
    assert.equal(
      await isRationedGraphqlRequest(make('/graphql', 'a=b'), async () => ({
        userId: 'u',
        activeOrganizationId: null,
      })),
      false,
    );
  });

  it('fails closed, and logs, when the lookup throws', async () => {
    warnings.length = 0;
    const result = await isRationedGraphqlRequest(
      make('/graphql', 'a=b'),
      async () => {
        throw new Error('db down');
      },
    );
    assert.equal(result, true);
    assert.equal(warnings.length, 1);
    const [context] = warnings[0] as [{ err: Error }];
    assert.equal(context.err.message, 'db down');
  });
});
