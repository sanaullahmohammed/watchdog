import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

/** Story 2.13 — read maintenance windows. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `rdm-${randomBytes(4).toString('hex')}`;
const hour = 60 * 60 * 1000;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let serviceAId = '';
let scheduledId = '';

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

async function schedule(
  cookie: string,
  title: string,
  serviceIds: string[] = [],
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/maintenance',
    headers: { cookie, origin: ORIGIN },
    payload: {
      title,
      scheduledStartAt: new Date(Date.now() + hour).toISOString(),
      scheduledEndAt: new Date(Date.now() + 2 * hour).toISOString(),
      affectedServiceIds: serviceIds,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

async function list(cookie: string, query = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/maintenance${query}`,
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as { title: string; status: string }[];
}

describe('Story 2.13: read maintenance windows', () => {
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

    const svc = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { cookie: cookieA, origin: ORIGIN },
      payload: { name: `${tag}-svc`, slug: `${tag}-svc` },
    });
    serviceAId = JSON.parse(svc.body).id;

    scheduledId = await schedule(cookieA, `${tag}-scheduled`, [serviceAId]);

    // The other two states have no command yet - they arrive in stories 2.14
    // and 2.15 - so they are constructed directly to prove the read handles
    // all three, which is what FR8's verification line asks for.
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        insert into maintenance (org_id, title, status, scheduled_start_at, scheduled_end_at, started_at)
        values (${orgAId}, ${`${tag}-running`}, 'in_progress',
                now() - interval '1 hour', now() + interval '1 hour', now() - interval '1 hour')
      `;
      await tx`
        insert into maintenance (org_id, title, status, scheduled_start_at, scheduled_end_at, started_at, completed_at)
        values (${orgAId}, ${`${tag}-done`}, 'completed',
                now() - interval '3 hours', now() - interval '2 hours',
                now() - interval '3 hours', now() - interval '2 hours')
      `;
    });
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('returns all three states, distinguishable', async () => {
    const byTitle = new Map(
      (await list(cookieA)).map((w) => [w.title, w.status]),
    );

    assert.equal(byTitle.get(`${tag}-scheduled`), 'scheduled');
    assert.equal(byTitle.get(`${tag}-running`), 'in_progress');
    assert.equal(byTitle.get(`${tag}-done`), 'completed');
  });

  it('filters by status', async () => {
    const running = await list(cookieA, '?status=in_progress');

    assert.ok(running.every((w) => w.status === 'in_progress'));
    assert.ok(running.some((w) => w.title === `${tag}-running`));
  });

  it('brings affected services with a window read on its own', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/maintenance/${scheduledId}`,
      headers: { cookie: cookieA, origin: ORIGIN },
    });

    assert.equal(response.statusCode, 200, response.body);
    const window = JSON.parse(response.body);
    assert.deepEqual(window.affectedServiceIds, [serviceAId]);
    assert.equal(window.status, 'scheduled');
    assert.equal(window.completedAt, null);
  });

  it('carries affected services on the list too, without a query per window', async () => {
    // The list gathers links in one query rather than one per window. Asserted
    // through behaviour: every window that has services shows them.
    const windows = (await list(cookieA)) as unknown as {
      title: string;
      affectedServiceIds: string[];
    }[];

    const scheduled = windows.find((w) => w.title === `${tag}-scheduled`);
    assert.deepEqual(scheduled?.affectedServiceIds, [serviceAId]);

    const running = windows.find((w) => w.title === `${tag}-running`);
    assert.deepEqual(running?.affectedServiceIds, []);
  });

  it('keeps each organization reading only its own', async () => {
    assert.deepEqual(await list(cookieB), []);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/maintenance/${scheduledId}`,
      headers: { cookie: cookieB, origin: ORIGIN },
    });

    assert.equal(foreign.statusCode, 404, foreign.body);
  });
});
