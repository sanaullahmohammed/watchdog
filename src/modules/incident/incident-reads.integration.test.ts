import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { signUpWithOrg } from '@/shared/testing/tenant';

/** Story 2.11 — read an incident timeline in order, and list incidents. */

const ORIGIN = 'http://localhost:3000';
const tag = `rd-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let openIncidentId = '';

async function declare(cookie: string, title: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: ORIGIN },
    payload: { title, impact: 'major' },
  });
  return JSON.parse(response.body).id as string;
}

async function listIncidents(cookie: string, query = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/incidents${query}`,
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as { title: string; status: string }[];
}

describe('Story 2.11: read incidents and their timelines', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, `${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(app, `${tag}-b`));

    openIncidentId = await declare(cookieA, `${tag}-open`);
    const resolved = await declare(cookieA, `${tag}-resolved`);
    await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${resolved}/transition`,
      headers: { cookie: cookieA, origin: ORIGIN },
      payload: { status: 'resolved' },
    });

    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        insert into incidents (org_id, title, status, impact, source)
        values (${orgAId}, ${`${tag}-draft`}, 'draft', 'major', 'monitoring')
      `;
    });
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('orders a timeline deterministically when entries share a timestamp', async () => {
    // All three carry the same created_at, set explicitly. The column defaults
    // to clock_timestamp(), so rows written in one transaction no longer tie on
    // their own, and only the id tiebreaker can order these.
    const at = new Date();
    const ids = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ id: string }[]>`
        insert into incident_updates (
          org_id, incident_id, status, message, created_at
        )
        values
          (${orgAId}, ${openIncidentId}, 'investigating', 'one', ${at}),
          (${orgAId}, ${openIncidentId}, 'investigating', 'two', ${at}),
          (${orgAId}, ${openIncidentId}, 'investigating', 'three', ${at})
        returning id
      `;
      return rows.map((row) => row.id);
    });

    const read = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/incidents/${openIncidentId}/updates`,
        headers: { cookie: cookieA, origin: ORIGIN },
      });
      assert.equal(response.statusCode, 200, response.body);
      return (JSON.parse(response.body) as { id: string }[]).map((e) => e.id);
    };

    // Declaring the incident wrote the first entry, earlier; these follow it.
    const timeline = await read();
    assert.ok(!ids.includes(timeline[0]), 'the declaration opens the timeline');
    const expected = [timeline[0], ...[...ids].sort()];
    assert.deepEqual(timeline, expected);
    // Read twice: an order that depends on the planner rather than the index
    // can differ between identical queries.
    assert.deepEqual(await read(), expected);
  });

  it('returns identical incidents and timelines over REST and GraphQL', async () => {
    // The parity contract compares the request shapes each surface accepts,
    // never the responses they build. One presenter per response is what keeps
    // these equal; two hand-written mappings drifted apart unnoticed before.
    const gql = async <T>(query: string, variables?: object) => {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { cookie: cookieA, 'content-type': 'application/json' },
        payload: { query, variables },
      });
      const body = JSON.parse(response.body) as { data: T; errors?: unknown[] };
      assert.equal(body.errors, undefined, response.body);
      return body.data;
    };

    const graphList = await gql<{ incidents: unknown[] }>(
      '{ incidents { id title status impact source startedAt resolvedAt } }',
    );
    assert.deepEqual(graphList.incidents, await listIncidents(cookieA));

    const restTimeline = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/incidents/${openIncidentId}/updates`,
          headers: { cookie: cookieA, origin: ORIGIN },
        })
      ).body,
    );
    const graphTimeline = await gql<{ incidentTimeline: unknown[] }>(
      'query ($id: ID!) { incidentTimeline(id: $id) { id status message createdAt } }',
      { id: openIncidentId },
    );
    assert.deepEqual(graphTimeline.incidentTimeline, restTimeline);
  });

  it('returns open and resolved incidents, distinguishable by status', async () => {
    const incidents = await listIncidents(cookieA);
    const byTitle = new Map(incidents.map((i) => [i.title, i.status]));

    assert.equal(byTitle.get(`${tag}-open`), 'investigating');
    assert.equal(byTitle.get(`${tag}-resolved`), 'resolved');
  });

  it('excludes drafts by default and from every public read', async () => {
    const titles = async (query: string) =>
      (await listIncidents(cookieA, query)).map((i) => i.title);

    assert.ok(
      !(await titles('')).includes(`${tag}-draft`),
      'excluded by default',
    );
    assert.ok(
      (await titles('?includeDrafts=true')).includes(`${tag}-draft`),
      'an admin can see a draft in order to confirm or dismiss it',
    );
    assert.ok(
      !(await titles('?publicOnly=true')).includes(`${tag}-draft`),
      'never on a public read',
    );
    assert.ok(
      !(await titles('?publicOnly=true&includeDrafts=true')).includes(
        `${tag}-draft`,
      ),
      'includeDrafts is an admin affordance and must not reopen a public read',
    );
  });

  it('filters by status', async () => {
    const resolved = await listIncidents(cookieA, '?status=resolved');

    assert.ok(resolved.every((i) => i.status === 'resolved'));
    assert.ok(resolved.some((i) => i.title === `${tag}-resolved`));
  });

  it('keeps each organization reading only its own', async () => {
    assert.deepEqual(await listIncidents(cookieB), []);

    const foreignTimeline = await app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${openIncidentId}/updates`,
      headers: { cookie: cookieB, origin: ORIGIN },
    });

    // 404 rather than an empty timeline: an empty list would imply the
    // incident exists and simply has no updates.
    assert.equal(foreignTimeline.statusCode, 404, foreignTimeline.body);
  });
});
