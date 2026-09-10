import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

/** Story 2.11 — read an incident timeline in order, and list incidents. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `rd-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let openIncidentId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function signUpWithOrg(label: string) {
  const email = `${label}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name: label },
  });
  const cookie = captureCookie(signUp.headers as Record<string, unknown>);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    select "id" from "user" where "email" = ${email}
  `;
  const org = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { cookie, origin: ORIGIN },
    payload: { name: label, slug: label },
  });
  return { cookie, userId, orgId: JSON.parse(org.body).id as string };
}

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
    } = await signUpWithOrg(`${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(`${tag}-b`));

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
    // Written inside one transaction, so created_at is identical for all three
    // and only the id tiebreaker can order them.
    const ids = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ id: string }[]>`
        insert into incident_updates (org_id, incident_id, status, message)
        values
          (${orgAId}, ${openIncidentId}, 'investigating', 'one'),
          (${orgAId}, ${openIncidentId}, 'investigating', 'two'),
          (${orgAId}, ${openIncidentId}, 'investigating', 'three')
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

    const expected = [...ids].sort();
    assert.deepEqual(await read(), expected);
    // Read twice: an order that depends on the planner rather than the index
    // can differ between identical queries.
    assert.deepEqual(await read(), expected);
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
