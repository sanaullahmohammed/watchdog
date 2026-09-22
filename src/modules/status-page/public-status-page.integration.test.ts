import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { SLUG_MAX_LENGTH } from '@/shared/domain/slug';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/** Story 3.2 — resolve an organization from its public slug. */

const tag = `pub-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
const slugA = `${tag}-a`;
const slugB = `${tag}-b`;

/** Pads a slug with valid characters to an exact length. */
const ofLength = (length: number) =>
  `${tag}-${'x'.repeat(length - tag.length - 1)}`;

/**
 * Organizations that exist, so a lookup would find each one. Only the slug
 * rule decides what happens to them, which is what makes them worth having:
 * a slug that merely matches nothing would 404 with or without the rule.
 */
const edge = {
  // Exactly as long as the rule allows. Served, which the router's default
  // 100-character param limit would have prevented.
  atLimit: { slug: ofLength(SLUG_MAX_LENGTH), id: '' },
  // One character over, every character valid.
  overLimit: { slug: ofLength(SLUG_MAX_LENGTH + 1), id: '' },
  // Better Auth accepts it; WatchDog's rule does not.
  offRule: { slug: `${tag.toUpperCase()}_OFF`, id: '' },
};

/** The one miss body, apart from the per-request correlation id. */
const MISS = {
  statusCode: 404,
  message: 'Status page not found',
  error: 'Not Found',
};

/** No cookie, no origin: the way anyone holding the link arrives. */
function fetchPage(slug: string, prefix = '') {
  return app.inject({ method: 'GET', url: `${prefix}/status/${slug}` });
}

async function gql(query: string, variables?: object) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: { query, variables },
  });
  return JSON.parse(response.body) as {
    data: { publicStatusPage?: unknown } | null;
    errors?: { message: string }[];
  };
}

describe('Story 3.2: resolve an organization from its public slug', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, slugA));
    ({ userId: userBId, orgId: orgBId } = await signUpWithOrg(app, slugB));

    // Owned by A: an operator may create several organizations.
    for (const org of Object.values(edge)) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/organization/create',
        headers: { cookie: cookieA, origin: TEST_ORIGIN },
        payload: { name: org.slug, slug: org.slug },
      });
      assert.equal(response.statusCode, 200, response.body);
      org.id = JSON.parse(response.body).id;
    }
  });

  after(async () => {
    const orgIds = [orgAId, orgBId, ...Object.values(edge).map((o) => o.id)];
    await sql`delete from "organization" where "id" in ${sql(orgIds)}`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('identifies the organization behind a slug, with no session', async () => {
    const response = await fetchPage(slugA);

    assert.equal(response.statusCode, 200, response.body);
    // The rest of the payload is story 3.3's; this suite is about which
    // organization the slug resolved to.
    assert.deepEqual(JSON.parse(response.body).organization, {
      name: slugA,
      slug: slugA,
    });
  });

  it('resolves each slug to its own organization', async () => {
    const [a, b] = await Promise.all([fetchPage(slugA), fetchPage(slugB)]);

    assert.equal(JSON.parse(a.body).organization.slug, slugA);
    assert.equal(JSON.parse(b.body).organization.slug, slugB);
  });

  it('answers 404 for a slug that matches nothing, with the one miss body', async () => {
    const response = await fetchPage(`${tag}-nobody`);

    assert.equal(response.statusCode, 404, response.body);
    // The whole body, not the absence of strings no implementation would
    // emit: the old check here passed with no public route at all (VG-A).
    const { correlationId, ...rest } = JSON.parse(response.body);
    assert.deepEqual(rest, MISS);
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
  });

  it('gives every miss that one answer, whatever was asked', async () => {
    // Unknown, too long for the router's default param limit, far too long,
    // malformed in each way the rule excludes, and two that exist but sit
    // outside the rule. Before R-8's fix the long ones got the router's 404,
    // which echoes the path, the NUL byte a 500, and the empty one a 400.
    const misses = {
      unknown: `${tag}-nobody`,
      'over 100 characters': `${tag}-${'n'.repeat(120)}`,
      '5000 characters': 'n'.repeat(5000),
      'a NUL byte': '%00',
      empty: '',
      'upper case': 'Nobody',
      'an encoded slash': `${tag}%2Fnobody`,
      'an existing slug over the length limit': edge.overLimit.slug,
      'an existing slug outside the pattern': edge.offRule.slug,
    };

    for (const [what, slug] of Object.entries(misses)) {
      const response = await fetchPage(slug);
      assert.equal(response.statusCode, 404, `${what}: ${response.body}`);
      const { correlationId: _, ...rest } = JSON.parse(response.body);
      assert.deepEqual(rest, MISS, what);
    }
  });

  it('serves a slug at the full length the rule allows', async () => {
    const response = await fetchPage(edge.atLimit.slug);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      JSON.parse(response.body).organization.slug,
      edge.atLimit.slug,
    );
  });

  it('serves the page at /status, not under the /api prefix', async () => {
    // FR17 names the path. Every other module route carries /api; this one is
    // loaded by the second, unprefixed pass.
    const prefixed = await fetchPage(slugA, '/api');

    assert.equal(prefixed.statusCode, 404, prefixed.body);
  });

  it('answers the same page over GraphQL, also without a session', async () => {
    const result = await gql(
      'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { organization { name slug } } }',
      { slug: slugA },
    );

    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    assert.deepEqual(result.data?.publicStatusPage, {
      organization: JSON.parse((await fetchPage(slugA)).body).organization,
    });
  });

  it('refuses every miss over GraphQL with one identical error', async () => {
    const query =
      'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { organization { slug } } }';
    const reference = await gql(query, { slug: `${tag}-nobody` });

    assert.deepEqual(reference, {
      data: null,
      errors: [
        {
          message: 'Status page not found',
          // Where the field sits in the query: 1-based, as GraphQL counts.
          locations: [
            { line: 1, column: query.indexOf('publicStatusPage') + 1 },
          ],
          path: ['publicStatusPage'],
        },
      ],
    });

    // `ID!` accepts the empty string REST's router never sees, and a NUL byte
    // once came back as Postgres's own encoding error.
    for (const [what, slug] of Object.entries({
      'over 100 characters': `${tag}-${'n'.repeat(120)}`,
      'a NUL byte': '\u0000',
      empty: '',
      'upper case': 'Nobody',
      'an existing slug over the length limit': edge.overLimit.slug,
      'an existing slug outside the pattern': edge.offRule.slug,
    })) {
      assert.deepEqual(await gql(query, { slug }), reference, what);
    }

    const atLimit = await gql(query, { slug: edge.atLimit.slug });
    assert.deepEqual(atLimit, {
      data: { publicStatusPage: { organization: { slug: edge.atLimit.slug } } },
    });
  });
});
