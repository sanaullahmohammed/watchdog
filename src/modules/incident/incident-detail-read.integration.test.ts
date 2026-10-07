import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import {
  type TenantTransaction,
  withTenantTransaction,
} from '@/shared/db/tenant-transaction';
import { incidentUpdatedEvent } from '@/shared/events/incident.events';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 9.7: a client can read one incident with the services it names, over
 * REST and GraphQL alike, and feed what it read back to the edit unchanged.
 */

const tag = `idr-${randomBytes(4).toString('hex')}`;

interface Detail {
  id: string;
  title: string;
  status: string;
  impact: string;
  source: string;
  startedAt: string;
  resolvedAt: string | null;
  affectedServices: { serviceId: string; impact: string }[];
}

let app: FastifyInstance;
const orgIds: string[] = [];
const userIds: string[] = [];
let orgAId = '';
let cookieA = '';
let cookieB = '';
let serviceLow = '';
let serviceHigh = '';
let twoId = '';
let emptyId = '';
let draftId = '';
const updatedIds: string[] = [];

async function createService(cookie: string, slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { name: slug, slug },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

async function declare(cookie: string, payload: object) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

function rest(url: string, cookie?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: cookie ? { cookie, origin: TEST_ORIGIN } : {},
  });
}

function patch(id: string, payload: object) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/incidents/${id}`,
    headers: { cookie: cookieA, origin: TEST_ORIGIN },
    payload,
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

const FIELDS = `id title status impact source startedAt resolvedAt
  affectedServices { serviceId impact }`;
const ONE = `query($id: ID!) { incident(id: $id) { ${FIELDS} } }`;
const UPDATE = `mutation($id: ID!, $input: UpdateIncidentPayload!) {
  updateIncident(id: $id, input: $input) }`;

async function readRest(id: string) {
  const response = await rest(`/incidents/${id}`, cookieA);
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as Detail;
}

async function readGql(id: string) {
  const result = await gql(ONE, cookieA, { id });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  return result.body.data?.incident as Detail;
}

async function updatedFor(run: () => Promise<unknown>, id: string) {
  await app.eventBus.drain();
  updatedIds.length = 0;
  await run();
  await app.eventBus.drain();
  return updatedIds.filter((seen) => seen === id).length;
}

describe('Story 9.7: read one incident with its affected services', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    app.eventBus.on(incidentUpdatedEvent.type, (event: unknown) => {
      updatedIds.push((event as { payload: { id: string } }).payload.id);
    });
    const a = await signUpWithOrg(app, `${tag}-a`);
    const b = await signUpWithOrg(app, `${tag}-b`);
    cookieA = a.cookie;
    cookieB = b.cookie;
    orgAId = a.orgId;
    orgIds.push(a.orgId, b.orgId);
    userIds.push(a.userId, b.userId);

    const first = await createService(cookieA, `${tag}-s1`);
    const second = await createService(cookieA, `${tag}-s2`);
    [serviceLow, serviceHigh] = [first, second].sort();

    // The larger serviceId goes first, so only an order by puts them right.
    twoId = await declare(cookieA, {
      title: `${tag}-two`,
      impact: 'major',
      affectedServices: [
        { serviceId: serviceHigh, impact: 'minor' },
        { serviceId: serviceLow, impact: 'major' },
      ],
    });
    emptyId = await declare(cookieA, { title: `${tag}-none`, impact: 'minor' });

    draftId = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ id: string }[]>`
        insert into incidents (org_id, title, status, impact, source)
        values (${orgAId}, ${`${tag}-draft`}, 'draft', 'major', 'monitoring')
        returning id
      `;
      return rows[0].id;
    });
  });

  after(async () => {
    await sql`delete from "organization" where "id" in ${sql(orgIds)}`;
    await sql`delete from "user" where "id" in ${sql(userIds)}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('returns both services ordered by serviceId, alike on both surfaces', async () => {
    const viaRest = await readRest(twoId);
    const viaGql = await readGql(twoId);

    assert.equal(viaRest.title, `${tag}-two`);
    assert.equal(viaRest.status, 'investigating');
    assert.deepEqual(viaRest.affectedServices, [
      { serviceId: serviceLow, impact: 'major' },
      { serviceId: serviceHigh, impact: 'minor' },
    ]);
    assert.deepEqual(viaGql, viaRest);
  });

  it('returns an empty list for an incident naming no services', async () => {
    assert.deepEqual((await readRest(emptyId)).affectedServices, []);
    assert.deepEqual((await readGql(emptyId)).affectedServices, []);
  });

  it('returns a draft', async () => {
    const viaRest = await readRest(draftId);
    assert.equal(viaRest.status, 'draft');
    assert.deepEqual(await readGql(draftId), viaRest);
  });

  it('accepts the REST response whole as an edit and changes nothing', async () => {
    const first = await readRest(twoId);

    const emitted = await updatedFor(async () => {
      const response = await patch(twoId, first);
      assert.equal(response.statusCode, 200, response.body);
    }, twoId);

    assert.equal(emitted, 0, 'incident.updated was emitted for a no-op');
    assert.deepEqual(await readRest(twoId), first);
  });

  it('accepts the GraphQL read as the edit input and changes nothing', async () => {
    const first = await readGql(twoId);
    const { title, impact, affectedServices } = first;

    const emitted = await updatedFor(async () => {
      const result = await gql(UPDATE, cookieA, {
        id: twoId,
        input: { title, impact, affectedServices },
      });
      assert.equal(result.statusCode, 200, JSON.stringify(result.body));
      assert.equal(result.body.errors, undefined);
    }, twoId);

    assert.equal(emitted, 0, 'incident.updated was emitted for a no-op');
    assert.deepEqual(await readGql(twoId), first);
  });

  it('does emit when an impact really changes (positive control)', async () => {
    const first = await readRest(twoId);
    const changed = first.affectedServices.map((s, i) =>
      i === 0 ? { ...s, impact: 'critical' } : s,
    );

    const emitted = await updatedFor(async () => {
      const response = await patch(twoId, { affectedServices: changed });
      assert.equal(response.statusCode, 200, response.body);
    }, twoId);

    assert.equal(emitted, 1);
    assert.deepEqual((await readRest(twoId)).affectedServices, changed);
  });

  it('reads one snapshot even when an edit commits between its two statements', async () => {
    const id = await declare(cookieA, {
      title: `${tag}-snap`,
      impact: 'minor',
      affectedServices: [{ serviceId: serviceLow, impact: 'minor' }],
    });
    const repository = app.diContainer.resolve('incidentRepository') as {
      findById: (tx: TenantTransaction, id: string) => Promise<unknown>;
    };
    const findById = repository.findById;
    repository.findById = async (tx, incidentId) => {
      await withTenantTransaction(orgAId, async ({ sql: other }) => {
        await other`update incidents set title = ${`${tag}-snap-new`} where id = ${id}`;
        await other`
          update incident_service_impacts set impact = 'critical'
          where incident_id = ${id}
        `;
      });
      return findById.call(repository, tx, incidentId);
    };

    let during: Detail;
    try {
      during = await readRest(id);
    } finally {
      repository.findById = findById;
    }

    assert.equal(during.title, `${tag}-snap`);
    assert.deepEqual(during.affectedServices, [
      { serviceId: serviceLow, impact: 'minor' },
    ]);

    const after = await readRest(id);
    assert.equal(after.title, `${tag}-snap-new`);
    assert.deepEqual(after.affectedServices, [
      { serviceId: serviceLow, impact: 'critical' },
    ]);
  });

  it('ignores read-only fields sent to PATCH', async () => {
    const id = await declare(cookieA, { title: `${tag}-ro`, impact: 'minor' });
    const first = await readRest(id);

    const response = await patch(id, {
      status: 'resolved',
      source: 'monitoring',
      startedAt: '2001-01-01T00:00:00.000Z',
      resolvedAt: '2002-02-02T00:00:00.000Z',
    });
    assert.equal(response.statusCode, 200, response.body);

    const again = await readRest(id);
    assert.equal(again.status, first.status);
    assert.equal(again.source, first.source);
    assert.equal(again.startedAt, first.startedAt);
    assert.equal(again.resolvedAt, first.resolvedAt);
  });

  it('reads a resolved incident with its resolvedAt on both surfaces', async () => {
    const id = await declare(cookieA, { title: `${tag}-res`, impact: 'minor' });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${id}/transition`,
      headers: { cookie: cookieA, origin: TEST_ORIGIN },
      payload: { status: 'resolved' },
    });
    assert.equal(response.statusCode, 200, response.body);

    const viaRest = await readRest(id);
    assert.equal(viaRest.status, 'resolved');
    assert.ok(viaRest.resolvedAt);
    assert.equal(
      new Date(viaRest.resolvedAt).toISOString(),
      viaRest.resolvedAt,
    );
    assert.deepEqual(await readGql(id), viaRest);
  });

  it("answers 404 for another organization's incident", async () => {
    const viaRest = await rest(`/incidents/${twoId}`, cookieB);
    assert.equal(viaRest.statusCode, 404, viaRest.body);

    const viaGql = await gql(ONE, cookieB, { id: twoId });
    assert.equal(viaGql.statusCode, 404);
    assert.equal(viaGql.body.data, null);
    assert.match(viaGql.body.errors?.[0]?.message ?? '', /not found/i);
  });

  it('answers 404 for an unknown id', async () => {
    const id = randomUUID();
    assert.equal((await rest(`/incidents/${id}`, cookieA)).statusCode, 404);

    const viaGql = await gql(ONE, cookieA, { id });
    assert.equal(viaGql.statusCode, 404);
    assert.equal(viaGql.body.data, null);
    assert.match(viaGql.body.errors?.[0]?.message ?? '', /not found/i);
  });

  it('answers 400 for a malformed id', async () => {
    const viaRest = await rest('/incidents/not-a-uuid', cookieA);
    assert.equal(viaRest.statusCode, 400, viaRest.body);

    const viaGql = await gql(ONE, cookieA, { id: 'not-a-uuid' });
    assert.equal(viaGql.statusCode, 400);
    assert.equal(viaGql.body.data, null);
    const message = viaGql.body.errors?.[0]?.message ?? '';
    assert.match(message, /^Invalid input\./);
    assert.match(message, /\bid\b/);
  });

  it('answers 401 without a session', async () => {
    assert.equal((await rest(`/incidents/${twoId}`)).statusCode, 401);

    const viaGql = await gql(ONE, undefined, { id: twoId });
    assert.equal(viaGql.statusCode, 200);
    assert.equal(viaGql.body.data, null);
    assert.equal(viaGql.body.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
  });

  it('still answers the timeline and the list', async () => {
    const timeline = await rest(`/incidents/${twoId}/updates`, cookieA);
    assert.equal(timeline.statusCode, 200, timeline.body);
    assert.ok(JSON.parse(timeline.body).length >= 1);

    const list = await rest('/incidents', cookieA);
    assert.equal(list.statusCode, 200, list.body);
    const titles = (JSON.parse(list.body) as { title: string }[]).map(
      (i) => i.title,
    );
    assert.ok(titles.includes(`${tag}-two`));
  });
});
