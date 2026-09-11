import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { timelineMessageFor } from '@/modules/incident/domain/incident-timeline';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentUpdatePostedEvent } from '@/shared/events/incident.events';

/** Story 2.10 — post an incident update. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `upd-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function declare(title: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: ORIGIN },
    payload: { title, impact: 'major' },
  });
  return JSON.parse(response.body).id as string;
}

function postUpdate(incidentId: string, message: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/incidents/${incidentId}/updates`,
    headers: { cookie, origin: ORIGIN },
    payload: { message },
  });
}

describe('Story 2.10: post an incident update', () => {
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
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('appends an update carrying the incident status at the time of writing', async () => {
    const incidentId = await declare('Timeline');

    const captured: unknown[] = [];
    app.eventBus.on(incidentUpdatePostedEvent.type, (e) => captured.push(e));

    const first = await postUpdate(incidentId, 'Looking into it');
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(captured.length, 1);

    // Move the incident on, then post again. The first entry must still read
    // `investigating`; a timeline that rewrote itself would be useless.
    await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/transition`,
      headers: { cookie, origin: ORIGIN },
      payload: { status: 'identified' },
    });
    await postUpdate(incidentId, 'Found the cause');

    const rows = await withTenantTransaction(orgId, async ({ sql: tx }) => {
      return tx<
        { status: string; message: string; created_by_user_id: string }[]
      >`
        select status, message, created_by_user_id from incident_updates
        where incident_id = ${incidentId}
        order by created_at, id
      `;
    });

    // Declaring and transitioning write entries of their own, interleaved with
    // the posted ones in the order they happened.
    assert.deepEqual(
      rows.map((row) => [row.status, row.message]),
      [
        ['investigating', timelineMessageFor(null, 'investigating')],
        ['investigating', 'Looking into it'],
        ['identified', timelineMessageFor('investigating', 'identified')],
        ['identified', 'Found the cause'],
      ],
    );
    assert.ok(rows.every((row) => row.created_by_user_id === userId));
    assert.equal(
      captured.length,
      2,
      'entries written by declaring and transitioning are announced by their own events, not update_posted',
    );
  });

  it('refuses an edit to an existing update', async () => {
    const incidentId = await declare('Immutable');
    await postUpdate(incidentId, 'original wording');

    // The declaration wrote an entry too, so the whole timeline is compared
    // rather than assuming the posted update is its only row.
    const messages = () =>
      withTenantTransaction(orgId, async ({ sql: tx }) =>
        (
          await tx<{ message: string }[]>`
            select message from incident_updates
            where incident_id = ${incidentId}
            order by created_at, id
          `
        ).map((row) => row.message),
      );
    const written = await messages();
    assert.ok(written.includes('original wording'));

    // Not "the repository has no update method" - anything holding a tenant
    // transaction could write raw SQL. The privilege itself is revoked.
    await assert.rejects(
      withTenantTransaction(orgId, async ({ sql: tx }) => {
        await tx`
          update incident_updates set message = 'rewritten'
          where incident_id = ${incidentId}
        `;
      }),
      /permission denied for table incident_updates/,
    );

    assert.deepEqual(await messages(), written);
  });

  it('refuses a delete of an existing update', async () => {
    const incidentId = await declare('Undeletable');
    await postUpdate(incidentId, 'permanent');

    const count = async () =>
      (
        await withTenantTransaction(
          orgId,
          ({ sql: tx }) =>
            tx`select 1 from incident_updates where incident_id = ${incidentId}`,
        )
      ).length;
    // The declaration's entry and the posted one.
    const written = await count();
    assert.equal(written, 2);

    await assert.rejects(
      withTenantTransaction(orgId, async ({ sql: tx }) => {
        await tx`delete from incident_updates where incident_id = ${incidentId}`;
      }),
      /permission denied for table incident_updates/,
    );

    assert.equal(await count(), written);
  });

  it('has no update or delete privilege granted to the runtime role', async () => {
    // The behavioural tests above prove today's schema. This asserts the grant
    // itself, so a future migration re-granting it fails here rather than
    // quietly making the timeline mutable again.
    const grants = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_name = 'incident_updates' and grantee = 'watchdog_app'
      order by privilege_type
    `;

    const held = grants.map((g) => g.privilege_type);
    assert.ok(held.includes('SELECT'));
    assert.ok(held.includes('INSERT'));
    assert.ok(
      !held.includes('UPDATE'),
      'append-only: UPDATE must not be granted',
    );
    assert.ok(
      !held.includes('DELETE'),
      'append-only: DELETE must not be granted',
    );
  });

  it('will not append to an incident in another organization', async () => {
    const response = await postUpdate(
      '00000000-0000-0000-0000-000000000000',
      'nope',
    );

    assert.equal(response.statusCode, 404, response.body);
  });
});
