import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { frameworkErrors, isUnderStatus } from '@/server/framework-errors';

/**
 * A route with an async constraint strategy that always fails, so the
 * async-constraint answer comes from Fastify itself rather than a literal.
 */
const build = async (withHandler: boolean) => {
  const app = Fastify({
    logger: false,
    routerOptions: { ignoreDuplicateSlashes: true },
    constraints: {
      boom: {
        name: 'boom',
        storage() {
          const handlers = new Map<string, unknown>();
          return {
            get: (k: string) => handlers.get(k) ?? null,
            set: (k: string, v: unknown) => {
              handlers.set(k, v);
            },
          };
        },
        validate: () => undefined,
        deriveConstraint(
          req: { url?: string },
          _ctx: unknown,
          done: (err: Error | null, value?: string) => void,
        ) {
          if (req.url === '/async') done(new Error('nope'));
          else done(null);
        },
      } as never,
    },
    ...(withHandler ? { frameworkErrors } : {}),
  });
  app.get('/status/:slug', async () => ({ ok: true }));
  app.get('/statusx/:slug', async () => ({ ok: true }));
  app.get('/async', { constraints: { boom: 'x' } }, async () => ({ ok: true }));
  await app.ready();
  return app;
};

describe('isUnderStatus', () => {
  it('judges the path as the router sees it', () => {
    assert.equal(isUnderStatus('/status'), true);
    assert.equal(isUnderStatus('/status/x'), true);
    assert.equal(isUnderStatus('/status/%E0'), true);
    assert.equal(isUnderStatus('/status?q=1'), true);
    assert.equal(isUnderStatus('//status/%E0'), true);
    assert.equal(isUnderStatus('/status//x'), true);
    assert.equal(isUnderStatus('http://h/status/%E0'), true);
    assert.equal(isUnderStatus('http://h//status/%E0?x=1'), true);
    assert.equal(isUnderStatus('/statusx'), false);
    assert.equal(isUnderStatus('/statusx%E0'), false);
    assert.equal(isUnderStatus('/api/nope'), false);
    assert.equal(isUnderStatus('/api/%E0?r=/status/'), false);
    assert.equal(isUnderStatus('/statusx?q=/status/%E0'), false);
    assert.equal(isUnderStatus('http://h/statusx/%E0'), false);
    assert.equal(isUnderStatus('/STATUS/x'), false);
    assert.equal(isUnderStatus('ftp://h/status/%E0'), false);
  });
});

describe('frameworkErrors', () => {
  it('answers a malformed URL under /status/ with a plain 400 and the public headers', async () => {
    const app = await build(true);
    const res = await app.inject({
      url: '/status/%E0',
      headers: { origin: 'https://example.test' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(
      res.headers['access-control-expose-headers'],
      'ETag, Retry-After',
    );
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.deepEqual(Object.keys(res.json()).sort(), [
      'correlationId',
      'error',
      'message',
      'statusCode',
    ]);
    assert.ok(!res.body.includes('%E0'), 'the path is not echoed');
    await app.close();
  });

  it('leaves every answer outside /status exactly as Fastify gives it', async () => {
    const plain = await build(false);
    const ours = await build(true);
    for (const url of [
      '/statusx%E0',
      '/api/%E0',
      '/api/%E0?r=/status/',
      '/statusx?q=/status/%E0',
      '/%E0',
      '/async',
    ]) {
      const a = await plain.inject({ url });
      const b = await ours.inject({ url });
      assert.equal(b.statusCode, a.statusCode, url);
      assert.equal(b.body, a.body, url);
      assert.equal(b.headers['content-type'], a.headers['content-type'], url);
      assert.equal(
        b.headers['content-length'],
        a.headers['content-length'],
        url,
      );
      assert.equal(b.headers['access-control-allow-origin'], undefined, url);
    }
    await plain.close();
    await ours.close();
  });
});
