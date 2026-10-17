import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { declareIncident } from '@/shared/testing/fixtures';
import { gqlData } from '@/shared/testing/graphql';
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

    openIncidentId = await declareIncident(app, cookieA, {
      title: `${tag}-open`,
      impact: 'major',
    });
    const resolved = await declareIncident(app, cookieA, {
      title: `${tag}-resolved`,
      impact: 'major',
    });
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

  it('orders a timeline by insert order, not by created_at', async () => {
    // The clock can step back. Two entries written one after the other, the
    // first stamped an hour ahead and the second an hour behind, must still
    // read in the order they were written.
    const id = await declareIncident(app, cookieA, {
      title: `${tag}-clock`,
      impact: 'major',
    });
    for (const [message, offset] of [
      ['first', '1 hour'],
      ['second', '-1 hour'],
    ] as const) {
      await withTenantTransaction(orgAId, async ({ sql: tx }) => {
        await tx`
          insert into incident_updates (
            org_id, incident_id, status, message, created_at
          )
          values (
            ${orgAId}, ${id}, 'investigating', ${message},
            now() + ${offset}::interval
          )
        `;
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${id}/updates`,
      headers: { cookie: cookieA, origin: ORIGIN },
    });
    assert.equal(response.statusCode, 200, response.body);
    const rest = JSON.parse(response.body) as { message: string }[];
    assert.equal(rest.length, 3);
    assert.deepEqual(
      rest.slice(1).map((e) => e.message),
      ['first', 'second'],
    );

    const graph = await gqlData<{ incidentTimeline: unknown[] }>(
      app,
      'query ($id: ID!) { incidentTimeline(id: $id) { id status message createdAt } }',
      { cookie: cookieA, variables: { id } },
    );
    assert.deepEqual(graph.incidentTimeline, rest);
  });

  it('orders a timeline deterministically when entries share a timestamp', async () => {
    // Same created_at, set explicitly, and ids chosen so the insert order is
    // the reverse of the uuid sort order: the old (created_at, id) order would
    // always read these reversed. Three statements, not one multi-row values,
    // since only separate inserts have a defined identity order.
    const at = new Date();
    // Fresh ids each run, so rows a crashed run left behind cannot collide.
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    const entries = [
      ['one', ids[0]],
      ['two', ids[1]],
      ['three', ids[2]],
    ] as const;
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      for (const [message, entryId] of entries) {
        await tx`
          insert into incident_updates (
            id, org_id, incident_id, status, message, created_at
          )
          values (
            ${entryId}, ${orgAId}, ${openIncidentId}, 'investigating',
            ${message}, ${at}
          )
        `;
      }
    });

    const read = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/incidents/${openIncidentId}/updates`,
        headers: { cookie: cookieA, origin: ORIGIN },
      });
      assert.equal(response.statusCode, 200, response.body);
      return (JSON.parse(response.body) as { message: string }[]).map(
        (e) => e.message,
      );
    };

    // Declaring the incident wrote the first entry, earlier; these follow it.
    const timeline = await read();
    assert.deepEqual(timeline.slice(1), ['one', 'two', 'three']);
    assert.deepEqual(await read(), timeline);
  });

  it('returns identical incidents and timelines over REST and GraphQL', async () => {
    // The parity contract compares the request shapes each surface accepts,
    // never the responses they build. One presenter per response is what keeps
    // these equal; two hand-written mappings drifted apart unnoticed before.
    const graphList = await gqlData<{ incidents: unknown[] }>(
      app,
      '{ incidents { id title status impact source startedAt resolvedAt } }',
      { cookie: cookieA },
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
    const graphTimeline = await gqlData<{ incidentTimeline: unknown[] }>(
      app,
      'query ($id: ID!) { incidentTimeline(id: $id) { id status message createdAt } }',
      { cookie: cookieA, variables: { id: openIncidentId } },
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
