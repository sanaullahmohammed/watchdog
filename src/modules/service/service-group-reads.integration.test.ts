import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 9.6: a client can read the service groups it can create and edit,
 * over REST and GraphQL alike.
 */

const tag = `sgr-${randomBytes(4).toString('hex')}`;

interface Group {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
}

let app: FastifyInstance;
const orgIds: string[] = [];
const userIds: string[] = [];
let cookieA = '';
let cookieB = '';
let cookieEmpty = '';
let ownGroup: { id: string };
let tiePair: { id: string }[] = [];

async function createGroup(
  cookie: string,
  name: string,
  slug: string,
  displayOrder: number,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/service-groups',
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { name, slug, displayOrder },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body) as { id: string };
}

function rest(url: string, cookie?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: cookie ? { cookie, origin: TEST_ORIGIN } : {},
  });
}

async function gql(query: string, cookie?: string, variables?: object) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: {
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json',
    },
    payload: { query, variables },
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as {
      data: Record<string, unknown> | null;
      errors?: { message: string; extensions?: { code?: string } }[];
    },
  };
}

const GROUP_FIELDS = 'id name slug displayOrder';
const LIST = `{ serviceGroups { ${GROUP_FIELDS} } }`;
const ONE = `query($id: ID!) { serviceGroup(id: $id) { ${GROUP_FIELDS} } }`;

describe('Story 9.6: read service groups', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    const a = await signUpWithOrg(app, `${tag}-a`);
    const b = await signUpWithOrg(app, `${tag}-b`);
    const empty = await signUpWithOrg(app, `${tag}-e`);
    cookieA = a.cookie;
    cookieB = b.cookie;
    cookieEmpty = empty.cookie;
    orgIds.push(a.orgId, b.orgId, empty.orgId);
    userIds.push(a.userId, b.userId, empty.userId);

    // Created in reverse of the expected order.
    await createGroup(cookieA, 'Alpha', `${tag}-alpha`, 2);
    await createGroup(cookieA, 'Charlie', `${tag}-charlie`, 1);
    ownGroup = await createGroup(cookieA, 'Bravo', `${tag}-bravo`, 1);

    // Equal display order and name: only id settles them. Recreate until the
    // first inserted holds the larger id, which is the order a missing id sort
    // key would get wrong about half the time.
    for (let attempt = 0; attempt < 40; attempt++) {
      const first = await createGroup(cookieA, 'Tie', `${tag}-tie-a`, 0);
      const second = await createGroup(cookieA, 'Tie', `${tag}-tie-b`, 0);
      if (first.id > second.id) {
        tiePair = [first, second];
        break;
      }
      for (const g of [first, second]) {
        const r = await app.inject({
          method: 'DELETE',
          url: `/api/v1/service-groups/${g.id}`,
          headers: { cookie: cookieA, origin: TEST_ORIGIN },
        });
        assert.equal(r.statusCode, 204, r.body);
      }
    }
    assert.equal(tiePair.length, 2, 'could not build a descending id pair');

    await createGroup(cookieB, 'Other org', `${tag}-other`, 0);
  });

  after(async () => {
    await sql`delete from "organization" where "id" in ${sql(orgIds)}`;
    await sql`delete from "user" where "id" in ${sql(userIds)}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  // Hard-coded: the database collation decides name order. The tied pair was
  // built so the second-created group sorts first by id.
  const expectedSlugs = () => [
    `${tag}-tie-b`,
    `${tag}-tie-a`,
    `${tag}-bravo`,
    `${tag}-charlie`,
    `${tag}-alpha`,
  ];

  it('lists in display order, then name, then id, identically over both', async () => {
    const r = await rest('/service-groups', cookieA);
    assert.equal(r.statusCode, 200, r.body);
    const restBody = JSON.parse(r.body) as Group[];
    assert.deepEqual(
      restBody.map((g) => g.slug),
      expectedSlugs(),
    );
    assert.deepEqual(Object.keys(restBody[0]).sort(), [
      'displayOrder',
      'id',
      'name',
      'slug',
    ]);

    const g = await gql(LIST, cookieA);
    assert.equal(g.statusCode, 200);
    assert.deepEqual(g.body.data?.serviceGroups, restBody);
  });

  it('answers an empty list as []', async () => {
    const r = await rest('/service-groups', cookieEmpty);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), []);
    const g = await gql(LIST, cookieEmpty);
    assert.deepEqual(g.body.data, { serviceGroups: [] });
  });

  it('reads its own group identically over both', async () => {
    const r = await rest(`/service-groups/${ownGroup.id}`, cookieA);
    assert.equal(r.statusCode, 200, r.body);
    const restBody = JSON.parse(r.body);
    assert.deepEqual(restBody, {
      id: ownGroup.id,
      name: 'Bravo',
      slug: `${tag}-bravo`,
      displayOrder: 1,
    });
    const g = await gql(ONE, cookieA, { id: ownGroup.id });
    assert.deepEqual(g.body.data, { serviceGroup: restBody });
  });

  it('answers 404 for another organization, as for an unknown id', async () => {
    const unknown = randomUUID();
    for (const id of [ownGroup.id, unknown]) {
      const cookie = id === ownGroup.id ? cookieB : cookieA;
      const r = await rest(`/service-groups/${id}`, cookie);
      assert.equal(r.statusCode, 404, r.body);
      const g = await gql(ONE, cookie, { id });
      assert.equal(g.statusCode, 404);
      assert.equal(g.body.data, null);
      assert.match(g.body.errors?.[0]?.message ?? '', /not found/);
    }
  });

  it('refuses a malformed id', async () => {
    const r = await rest('/service-groups/not-a-uuid', cookieA);
    assert.equal(r.statusCode, 400, r.body);
    const g = await gql(ONE, cookieA, { id: 'not-a-uuid' });
    assert.equal(g.statusCode, 400);
    assert.equal(g.body.data, null);
    const message = g.body.errors?.[0]?.message ?? '';
    assert.match(message, /^Invalid input\./);
    assert.match(message, /\bid\b/);
    assert.doesNotMatch(message, /Internal Server Error/);
  });

  it('requires a session on both surfaces', async () => {
    assert.equal((await rest('/service-groups')).statusCode, 401);
    assert.equal(
      (await rest(`/service-groups/${ownGroup.id}`)).statusCode,
      401,
    );
    for (const [query, variables] of [
      [LIST, undefined],
      [ONE, { id: ownGroup.id }],
    ] as const) {
      const g = await gql(query, undefined, variables);
      // mercurius answers 200 for an ErrorWithProps carrying no HTTP status.
      assert.equal(g.statusCode, 200);
      assert.equal(g.body.data, null);
      assert.equal(g.body.errors?.[0]?.message, 'Authentication required');
      assert.equal(g.body.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
    }
  });

  it('reads a group back after an edit, and 404s after a delete', async () => {
    const { id } = await createGroup(cookieA, 'Edit me', `${tag}-edit`, 9);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/service-groups/${id}`,
      headers: { cookie: cookieA, origin: TEST_ORIGIN },
      payload: { name: 'Zulu', slug: `${tag}-zulu`, displayOrder: 99 },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const expected = {
      id,
      name: 'Zulu',
      slug: `${tag}-zulu`,
      displayOrder: 99,
    };

    const r = await rest(`/service-groups/${id}`, cookieA);
    assert.deepEqual(JSON.parse(r.body), expected);
    const g = await gql(ONE, cookieA, { id });
    assert.deepEqual(g.body.data, { serviceGroup: expected });

    const list = JSON.parse((await rest('/service-groups', cookieA)).body);
    assert.deepEqual(list.at(-1), expected);
    const gList = await gql(LIST, cookieA);
    assert.deepEqual(gList.body.data?.serviceGroups, list);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/service-groups/${id}`,
      headers: { cookie: cookieA, origin: TEST_ORIGIN },
    });
    assert.equal(del.statusCode, 204, del.body);
    assert.equal(
      (await rest(`/service-groups/${id}`, cookieA)).statusCode,
      404,
    );
    const gone = await gql(ONE, cookieA, { id });
    assert.equal(gone.statusCode, 404);
    assert.equal(gone.body.data, null);
    assert.match(gone.body.errors?.[0]?.message ?? '', /not found/);
  });

  it('leaves existing service reads answering', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { cookie: cookieA, origin: TEST_ORIGIN },
      payload: { name: 'Svc', slug: `${tag}-svc` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = JSON.parse(created.body) as { id: string };

    const list = await rest('/services', cookieA);
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(
      (JSON.parse(list.body) as { id: string }[]).map((s) => s.id),
      [id],
    );
    const one = await rest(`/services/${id}`, cookieA);
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(JSON.parse(one.body).id, id);
  });
});
