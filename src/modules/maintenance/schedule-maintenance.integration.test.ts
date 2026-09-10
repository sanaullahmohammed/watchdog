import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  maintenanceCreatedEvent,
  maintenanceUpdatedEvent,
} from '@/shared/events/maintenance.events';

/** Story 2.12 — schedule a maintenance window. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `mnt-${randomBytes(4).toString('hex')}`;
const hour = 60 * 60 * 1000;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let serviceAId = '';
let serviceBId = '';

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

async function createService(cookie: string, slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: { cookie, origin: ORIGIN },
    payload: { name: slug, slug },
  });
  return JSON.parse(response.body).id as string;
}

function schedule(cookie: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/maintenance',
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

const startAt = new Date(Date.now() + hour).toISOString();
const endAt = new Date(Date.now() + 2 * hour).toISOString();

async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

describe('Story 2.12: schedule a maintenance window', () => {
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
    serviceAId = await createService(cookieA, `${tag}-svc-a`);
    serviceBId = await createService(cookieB, `${tag}-svc-b`);
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('persists a window as scheduled and emits maintenance.created', async () => {
    const { result, captured } = await capturing(
      maintenanceCreatedEvent.type,
      () =>
        schedule(cookieA, {
          title: 'Database upgrade',
          scheduledStartAt: startAt,
          scheduledEndAt: endAt,
          affectedServiceIds: [serviceAId],
        }),
    );

    assert.equal(result.statusCode, 201, result.body);
    assert.equal(captured.length, 1);

    const { id } = JSON.parse(result.body);
    const row = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ status: string; started_at: Date | null }[]>`
        select status, started_at from maintenance where id = ${id}
      `;
      return rows[0];
    });
    assert.deepEqual(row, { status: 'scheduled', started_at: null });

    const services = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) =>
        tx<{ service_id: string }[]>`
        select service_id from maintenance_services where maintenance_id = ${id}
      `,
    );
    assert.deepEqual(
      services.map((s) => s.service_id),
      [serviceAId],
    );
  });

  it('rejects a window that ends before it starts', async () => {
    const response = await schedule(cookieA, {
      title: 'Backwards',
      scheduledStartAt: endAt,
      scheduledEndAt: startAt,
    });

    assert.equal(response.statusCode, 400, response.body);
  });

  it('rejects a zero-length window', async () => {
    const response = await schedule(cookieA, {
      title: 'Instantaneous',
      scheduledStartAt: startAt,
      scheduledEndAt: startAt,
    });

    // The constraint is `end > start`, not `end >= start`: a window with no
    // duration would start and complete in the same worker pass.
    assert.equal(response.statusCode, 400, response.body);
  });

  it('rejects a window at the database as well as the API', async () => {
    await assert.rejects(
      withTenantTransaction(orgAId, async ({ sql: tx }) => {
        await tx`
          insert into maintenance (org_id, title, scheduled_start_at, scheduled_end_at)
          values (${orgAId}, 'direct', now() + interval '2 hours', now() + interval '1 hour')
        `;
      }),
      /maintenance_window_ck/,
    );
  });

  it('refuses to attach a service from another organization', async () => {
    const response = await schedule(cookieA, {
      title: 'Cross-tenant',
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
      affectedServiceIds: [serviceBId],
    });

    assert.equal(response.statusCode, 400, response.body);
  });

  it('changes times and affected services, emitting maintenance.updated', async () => {
    const created = await schedule(cookieA, {
      title: 'Moving target',
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
    });
    const { id } = JSON.parse(created.body);
    const newEnd = new Date(Date.now() + 3 * hour).toISOString();

    const { result, captured } = await capturing(
      maintenanceUpdatedEvent.type,
      () =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/maintenance/${id}`,
          headers: { cookie: cookieA, origin: ORIGIN },
          payload: { scheduledEndAt: newEnd, affectedServiceIds: [serviceAId] },
        }),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.equal(captured.length, 1);

    const row = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ scheduled_end_at: Date }[]>`
        select scheduled_end_at from maintenance where id = ${id}
      `;
      return rows[0];
    });
    assert.equal(row.scheduled_end_at.toISOString(), newEnd);
  });

  it('rejects an edit that would invert an existing window', async () => {
    const created = await schedule(cookieA, {
      title: 'Do not invert',
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
    });
    const { id } = JSON.parse(created.body);

    // Only the start moves, past the existing end. The check has to be against
    // the window as it will be, not against the fields supplied.
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/maintenance/${id}`,
      headers: { cookie: cookieA, origin: ORIGIN },
      payload: {
        scheduledStartAt: new Date(Date.now() + 5 * hour).toISOString(),
      },
    });

    assert.equal(response.statusCode, 400, response.body);

    const row = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ scheduled_start_at: Date }[]>`
        select scheduled_start_at from maintenance where id = ${id}
      `;
      return rows[0];
    });
    assert.equal(row.scheduled_start_at.toISOString(), startAt);
  });

  it('does not let another organization change a window', async () => {
    const created = await schedule(cookieA, {
      title: 'Guarded',
      scheduledStartAt: startAt,
      scheduledEndAt: endAt,
    });
    const { id } = JSON.parse(created.body);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/maintenance/${id}`,
      headers: { cookie: cookieB, origin: ORIGIN },
      payload: { title: 'hijacked' },
    });

    assert.equal(response.statusCode, 404, response.body);
  });
});
