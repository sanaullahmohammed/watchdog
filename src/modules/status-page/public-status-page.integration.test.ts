import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { signUpWithOrg } from '@/shared/testing/tenant';

/** Story 3.2 — resolve an organization from its public slug. */

const tag = `pub-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
const slugA = `${tag}-a`;
const slugB = `${tag}-b`;

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
    ({ userId: userAId, orgId: orgAId } = await signUpWithOrg(app, slugA));
    ({ userId: userBId, orgId: orgBId } = await signUpWithOrg(app, slugB));
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('identifies the organization behind a slug, with no session', async () => {
    const response = await fetchPage(slugA);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), {
      organization: { name: slugA, slug: slugA },
    });
  });

  it('resolves each slug to its own organization', async () => {
    const [a, b] = await Promise.all([fetchPage(slugA), fetchPage(slugB)]);

    assert.equal(JSON.parse(a.body).organization.slug, slugA);
    assert.equal(JSON.parse(b.body).organization.slug, slugB);
  });

  it('answers 404 for a slug that matches nothing, and reveals nothing', async () => {
    const response = await fetchPage(`${tag}-nobody`);

    assert.equal(response.statusCode, 404, response.body);
    // One answer for every slug that resolves to nothing: the route must not
    // become a way to learn which organizations exist.
    assert.ok(!response.body.includes(slugA), response.body);
    assert.ok(!response.body.includes(orgAId), response.body);
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
    assert.deepEqual(
      result.data?.publicStatusPage,
      JSON.parse((await fetchPage(slugA)).body),
    );
  });

  it('refuses an unknown slug over GraphQL too', async () => {
    const result = await gql(
      'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { organization { slug } } }',
      { slug: `${tag}-nobody` },
    );

    assert.ok((result.errors ?? []).length > 0);
    assert.ok(!JSON.stringify(result).includes(slugA));
  });
});
