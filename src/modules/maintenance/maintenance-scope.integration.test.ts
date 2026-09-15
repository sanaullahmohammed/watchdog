import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { MaintenanceStatus } from '@/modules/maintenance/domain/maintenance.types';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * Epic 2 retrospective, R-8: what may be edited or deleted, and when.
 *
 * Stories 2.12 and 2.14 scope both to scheduled windows, and the routes say so
 * in their own descriptions, but nothing enforced it: a completed window could
 * be rewritten and a running one deleted.
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `scp-${randomBytes(4).toString('hex')}`;
const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

/** A window written straight to the table, in whichever status the case needs. */
async function windowIn(status: MaintenanceStatus) {
  const startOffset = status === 'scheduled' ? HOUR : -HOUR;
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<{ id: string }[]>`
      insert into maintenance (
        org_id, title, status, scheduled_start_at, scheduled_end_at,
        started_at, completed_at
      ) values (
        ${orgId}, ${`${tag}-${status}`}, ${status},
        ${new Date(Date.now() + startOffset)},
        ${new Date(Date.now() + 4 * HOUR)},
        ${status === 'scheduled' ? null : new Date(Date.now() + startOffset)},
        ${status === 'completed' ? new Date() : null}
      )
      returning id
    `;
    return row.id;
  });
}

async function rowOf(id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [row] = await tx<
      { status: MaintenanceStatus; title: string; scheduled_end_at: Date }[]
    >`
      select status, title, scheduled_end_at from maintenance where id = ${id}
    `;
    return row;
  });
}

describe('Maintenance edit and delete scope (Epic 2 retrospective, R-8)', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    const email = `${tag}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: tag },
    });
    cookie = captureCookie(signUp.headers as Record<string, unknown>);
    [{ id: userId }] = await sql<{ id: string }[]>`
      select "id" from "user" where "email" = ${email}
    `;
    const org = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: { cookie, origin: ORIGIN },
      payload: { name: tag, slug: tag },
    });
    orgId = JSON.parse(org.body).id;
    const service = await api('POST', '/services', {
      name: `${tag}-svc`,
      slug: `${tag}-svc`,
    });
    serviceId = JSON.parse(service.body).id;
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('deletes a scheduled window, which is work that never happened', async () => {
    const id = await windowIn('scheduled');

    const response = await api('DELETE', `/maintenance/${id}`);

    assert.equal(response.statusCode, 204, response.body);
    assert.equal(await rowOf(id), undefined);
  });

  it('refuses to delete a running or completed window, and keeps the record', async () => {
    for (const status of ['in_progress', 'completed'] as const) {
      const id = await windowIn(status);

      const response = await api('DELETE', `/maintenance/${id}`);

      assert.equal(response.statusCode, 409, `${status}: ${response.body}`);
      assert.match(response.body, /complete it instead/i);
      assert.equal((await rowOf(id)).status, status, 'the record survives');
    }
  });

  it('edits a scheduled window freely', async () => {
    const id = await windowIn('scheduled');

    const response = await api('PATCH', `/maintenance/${id}`, {
      title: `${tag}-retitled`,
      scheduledStartAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      scheduledEndAt: new Date(Date.now() + 5 * HOUR).toISOString(),
      affectedServiceIds: [serviceId],
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await rowOf(id)).title, `${tag}-retitled`);
  });

  it('extends a running window and corrects the services it covers', async () => {
    const id = await windowIn('in_progress');
    const newEnd = new Date(Date.now() + 6 * HOUR);

    const response = await api('PATCH', `/maintenance/${id}`, {
      scheduledEndAt: newEnd.toISOString(),
      affectedServiceIds: [serviceId],
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      (await rowOf(id)).scheduled_end_at.toISOString(),
      newEnd.toISOString(),
    );
  });

  it('refuses to retitle or re-start a running window', async () => {
    const id = await windowIn('in_progress');
    const before = await rowOf(id);

    for (const edit of [
      { title: `${tag}-nope` },
      { description: 'nope' },
      { scheduledStartAt: new Date(Date.now() + 3 * HOUR).toISOString() },
    ]) {
      const response = await api('PATCH', `/maintenance/${id}`, edit);

      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.body, /once it has started/i);
    }

    assert.equal((await rowOf(id)).title, before.title);
  });

  it('refuses every edit to a completed window', async () => {
    const id = await windowIn('completed');

    const response = await api('PATCH', `/maintenance/${id}`, {
      scheduledEndAt: new Date(Date.now() + 9 * HOUR).toISOString(),
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.body, /records work that happened/i);
  });

  it('still answers 404 for a window in another organization', async () => {
    const response = await api(
      'DELETE',
      '/maintenance/00000000-0000-0000-0000-000000000000',
    );

    assert.equal(response.statusCode, 404, response.body);
  });
});
