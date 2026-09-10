import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  maintenanceCompletedEvent,
  maintenanceDeletedEvent,
} from '@/shared/events/maintenance.events';

/** Story 2.14 — end a maintenance window: cancel or complete. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `end-${randomBytes(4).toString('hex')}`;
const hour = 60 * 60 * 1000;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let serviceAId = '';

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

function complete(cookie: string, id: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/maintenance/${id}/complete`,
    headers: { cookie, origin: ORIGIN },
  });
}

function remove(cookie: string, id: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/maintenance/${id}`,
    headers: { cookie, origin: ORIGIN },
  });
}

async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

function rowOf(id: string) {
  return withTenantTransaction(orgAId, async ({ sql: tx }) => {
    const rows = await tx<
      { status: string; completed_at: Date | null; scheduled_end_at: Date }[]
    >`select status, completed_at, scheduled_end_at from maintenance where id = ${id}`;
    return rows[0];
  });
}

describe('Story 2.14: end a maintenance window', () => {
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
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('removes a window for work that never happened', async () => {
    const id = await schedule(cookieA, `${tag}-never`, [serviceAId]);

    const { result, captured } = await capturing(
      maintenanceDeletedEvent.type,
      () => remove(cookieA, id),
    );

    assert.equal(result.statusCode, 204, result.body);
    assert.equal(captured.length, 1);
    assert.equal(await rowOf(id), undefined);

    // The join rows go with it rather than being orphaned.
    const links = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) =>
        tx`select 1 from maintenance_services where maintenance_id = ${id}`,
    );
    assert.equal(links.length, 0);
  });

  it('completes a cancelled window and keeps the record', async () => {
    const id = await schedule(cookieA, `${tag}-cancelled`);

    const { result, captured } = await capturing(
      maintenanceCompletedEvent.type,
      () => complete(cookieA, id),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { changed: true });
    assert.equal(captured.length, 1);

    const row = await rowOf(id);
    // Cancelling is not the same as never having planned it: the row survives,
    // which is the entire difference between this and delete.
    assert.ok(row, 'the window must still exist');
    assert.equal(row.status, 'completed');
    assert.ok(row.completed_at instanceof Date);
  });

  it('completes an in-progress window early, before its scheduled end', async () => {
    const id = await schedule(cookieA, `${tag}-early`);
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`
        update maintenance set status = 'in_progress', started_at = now()
        where id = ${id}
      `;
    });

    assert.equal((await complete(cookieA, id)).statusCode, 200);

    const row = await rowOf(id);
    assert.equal(row.status, 'completed');
    assert.ok(
      (row.completed_at as Date) < row.scheduled_end_at,
      'finished early means completed before the scheduled end',
    );
  });

  it('leaves nothing for the worker to pick up afterwards', async () => {
    const id = await schedule(cookieA, `${tag}-settled`);
    await complete(cookieA, id);

    // The worker in story 2.15 scans for due windows by status and time. A
    // completed window must match neither set, whatever the clock says. This
    // asserts the property that pass will rely on, before it exists.
    const due = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) =>
        tx<{ id: string }[]>`
        select id from maintenance
        where (status = 'scheduled' and now() >= scheduled_start_at)
           or (status = 'in_progress' and now() >= scheduled_end_at)
      `,
    );

    assert.ok(!due.some((row) => row.id === id));
  });

  it('is a no-op when the window is already completed', async () => {
    const id = await schedule(cookieA, `${tag}-twice`);
    await complete(cookieA, id);
    const firstCompletedAt = (await rowOf(id)).completed_at;

    const { result, captured } = await capturing(
      maintenanceCompletedEvent.type,
      () => complete(cookieA, id),
    );

    assert.deepEqual(JSON.parse(result.body), { changed: false });
    assert.equal(captured.length, 0);
    assert.deepEqual(
      (await rowOf(id)).completed_at,
      firstCompletedAt,
      'the original completion time must not be overwritten',
    );
  });

  it('does not let another organization end a window', async () => {
    const id = await schedule(cookieA, `${tag}-guarded`);

    assert.equal((await complete(cookieB, id)).statusCode, 404);
    assert.equal((await remove(cookieB, id)).statusCode, 404);
    assert.equal((await rowOf(id)).status, 'scheduled');
  });
});
