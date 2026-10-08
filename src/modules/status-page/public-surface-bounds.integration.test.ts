import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Epic 3 retrospective, action item 16 (R-5, R-15): what bounds the anonymous
 * surface, wired up. The rule and the tag have their own unit specs; this is
 * about the route and the schema actually applying them.
 */

const tag = `bounds-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';

const fetchPage = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/status/${tag}`, headers });

const ORIGIN = 'https://example.test';

/** The three public headers, and never credentials. */
const assertPublicHeaders = (headers: Record<string, unknown>) => {
  assert.equal(headers['access-control-allow-origin'], '*');
  assert.equal(headers['access-control-expose-headers'], 'ETag');
  // Helmet's default would keep a cross-origin reader out even with CORS.
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(
    headers['access-control-allow-credentials'],
    undefined,
    'no credentials: a public page is not read with someone else s session',
  );
};

const gql = (query: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { query },
  });

const page = (alias: string) =>
  `${alias}: publicStatusPage(orgSlug: "${tag}") { overallStatus }`;

describe('The public surface, bounded (retrospective R-5, R-15)', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('serves one page per GraphQL operation, and refuses a second', async () => {
    const one = await gql(`{ ${page('a')} }`);
    assert.equal(one.statusCode, 200, one.body);

    const two = await gql(`{ ${page('a')} ${page('b')} }`);
    assert.equal(two.statusCode, 400, two.body);
    assert.match(
      JSON.parse(two.body).errors[0].message,
      /publicStatusPage may be selected once per operation/,
    );

    // The measurement behind R-5: one request, a hundred compositions.
    const hundred = await gql(
      `{ ${[...Array(100).keys()].map((n) => page(`a${n}`)).join(' ')} }`,
    );
    assert.equal(hundred.statusCode, 400, hundred.body.slice(0, 200));
  });

  it('tells a poller when nothing has changed, and prices the answer at no body', async () => {
    const first = await fetchPage();
    assert.equal(first.statusCode, 200);
    assert.equal(
      first.headers['cache-control'],
      `public, max-age=${env.publicSurface.maxAgeSeconds}`,
    );
    const etag = first.headers.etag as string;
    assert.match(etag, /^"[\w-]+"$/);

    const again = await fetchPage();
    assert.equal(
      again.headers.etag,
      etag,
      'the same state answers the same tag, though generatedAt moved',
    );
    assert.notEqual(
      JSON.parse(again.body).generatedAt,
      JSON.parse(first.body).generatedAt,
    );

    const conditional = await fetchPage({ 'if-none-match': etag });
    assert.equal(conditional.statusCode, 304);
    assert.equal(conditional.body, '');
    assert.equal(conditional.headers.etag, etag);

    const stale = await fetchPage({ 'if-none-match': '"not-this-one"' });
    assert.equal(stale.statusCode, 200);
  });

  it('answers a new tag once the page says something new', async () => {
    const before = (await fetchPage()).headers.etag;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { cookie, origin: TEST_ORIGIN },
      payload: { name: 'Checkout', slug: `${tag}-checkout` },
    });
    assert.ok(created.statusCode < 300, created.body);
    await app.eventBus.drain();

    assert.notEqual((await fetchPage()).headers.etag, before);
  });

  it('lets a browser on any origin read the page, and revalidate it', async () => {
    const read = await fetchPage({ origin: ORIGIN });
    assert.equal(read.statusCode, 200);
    assertPublicHeaders(read.headers);

    const notModified = await fetchPage({
      origin: ORIGIN,
      'if-none-match': read.headers.etag as string,
    });
    assert.equal(notModified.statusCode, 304);
    assertPublicHeaders(notModified.headers);

    // A miss is read by the same script, so it needs the headers too: an
    // unknown slug, and one outside the slug rule.
    for (const slug of [`${tag}-missing`, 'Not_A_Slug']) {
      const miss = await app.inject({
        method: 'GET',
        url: `/status/${slug}`,
        headers: { origin: ORIGIN },
      });
      assert.equal(miss.statusCode, 404, miss.body);
      assertPublicHeaders(miss.headers);
    }

    // `If-None-Match` is not CORS-safelisted, so revalidating is preflighted.
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `/status/${tag}`,
      headers: {
        origin: 'https://example.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'if-none-match',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.match(
      preflight.headers['access-control-allow-headers'] as string,
      /if-none-match/,
    );
    assert.match(
      preflight.headers['access-control-allow-methods'] as string,
      /GET/,
    );
  });

  it('keeps the admin surface closed to other origins', async () => {
    // The global CORS setting stays `origin: false`: the page opted itself in,
    // and nothing else did.
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/services',
      headers: { cookie, origin: 'https://example.test' },
    });
    assert.equal(admin.headers['access-control-allow-origin'], undefined);
  });

  it('answers a junk cookie normally while under the limit', async () => {
    // The shared app, never flooded: its bucket holds a handful of requests.
    const send = (query: string) => gql(query, { cookie: 'junk=cookie' });
    const open = await send(`{ ${page('a')} }`);
    assert.equal(open.statusCode, 200, open.body);
    assert.equal(JSON.parse(open.body).errors, undefined, open.body);
    const admin = await send('{ services { id } }');
    assert.equal(admin.statusCode, 200, admin.body);
    const errors = JSON.parse(admin.body).errors;
    assert.ok(Array.isArray(errors), admin.body);
    assert.match(JSON.stringify(errors), /UNAUTHENTICATED/);
  });

  it('rations anonymous callers by IP, on both surfaces', async () => {
    // Its own instance: the limiter counts per app, and a spent bucket would
    // otherwise answer 429 to every later test in this file.
    const limited = await buildApp({ logger: false });
    await limited.ready();
    const max = env.publicSurface.rateLimit.max;

    /** Sends the same request until it is refused, or gives up past the limit. */
    type Response = Awaited<ReturnType<typeof app.inject>>;
    const flood = async (send: () => Promise<Response>) => {
      for (let sent = 1; sent <= max + 2; sent += 1) {
        const response = await send();
        if (response.statusCode === 429) return { sent, response };
      }
      return { sent: max + 2, response: undefined };
    };

    try {
      // Each surface has its own bucket: the page's comes from its route's
      // config, and anonymous GraphQL's from the hook.
      const page = await flood(() =>
        limited.inject({
          method: 'GET',
          url: `/status/${tag}`,
          headers: { origin: ORIGIN },
        }),
      );
      assert.ok(page.response, `the page was not rationed within ${max + 2}`);
      assert.equal(page.sent, max + 1, 'refused the request after the limit');
      assertPublicHeaders(page.response.headers);
      assert.equal(JSON.parse(page.response.body).error, 'Too Many Requests');
      assert.ok(
        page.response.headers['retry-after'],
        'and says when to come back',
      );

      const anonymous = await flood(() =>
        limited.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json' },
          payload: { query: '{ __typename }' },
        }),
      );
      assert.ok(anonymous.response, 'anonymous GraphQL was not rationed');
      // GraphQL's own shape: mercurius formats what a hook throws for its
      // route, and the message passes through because it is an ExceptionBase.
      assert.match(
        JSON.parse(anonymous.response.body).errors[0].message,
        /Rate limit exceeded, retry in \d+ seconds/,
      );

      // The bucket is spent, so every way of arriving without a valid session
      // is refused: a junk cookie, a signed-out one, the GET and HEAD
      // transports, and a doubled slash.
      const query = encodeURIComponent('{ __typename }');
      const refused = (response: Response, withBody = true) => {
        assert.equal(response.statusCode, 429, response.body);
        assert.ok(
          response.headers['retry-after'],
          'and says when to come back',
        );
        if (!withBody) return;
        const body = JSON.parse(response.body);
        assert.match(
          body.errors?.[0]?.message ?? body.message,
          /Rate limit exceeded, retry in \d+ seconds/,
        );
      };
      const json = { 'content-type': 'application/json' };
      const post = (url: string, headers: Record<string, string>) =>
        limited.inject({
          method: 'POST',
          url,
          headers: { ...json, ...headers },
          payload: { query: '{ __typename }' },
        });

      refused(await post('/graphql', { cookie: 'junk=cookie' }));
      refused(
        await post('/graphql', {
          cookie: 'better-auth.session_token=forged.not-a-signature',
        }),
      );

      const signedOut = await signUpWithOrg(limited, `${tag}-out`);
      try {
        const live = await post('/graphql', { cookie: signedOut.cookie });
        assert.notEqual(live.statusCode, 429, 'a live session is exempt');
        const out = await limited.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: { cookie: signedOut.cookie, origin: TEST_ORIGIN, ...json },
          payload: {},
        });
        assert.equal(out.statusCode, 200, out.body);
        refused(await post('/graphql', { cookie: signedOut.cookie }));
      } finally {
        await sql`delete from "organization" where "id" = ${signedOut.orgId}`;
        await sql`delete from "user" where "id" = ${signedOut.userId}`;
      }

      refused(
        await limited.inject({ method: 'GET', url: `/graphql?query=${query}` }),
      );
      refused(
        await limited.inject({
          method: 'HEAD',
          url: `/graphql?query=${query}`,
        }),
        false,
      );
      refused(await post('//graphql', {}));

      // An operator's request carries a session, and is not rationed with them,
      // although both buckets above are now spent.
      const operator = await limited.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', cookie },
        payload: { query: '{ services { id } }' },
      });
      assert.notEqual(operator.statusCode, 429, operator.body);
    } finally {
      await limited.close();
    }
  });
});
