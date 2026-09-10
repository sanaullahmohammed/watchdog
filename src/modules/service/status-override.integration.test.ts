import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  serviceManualOverrideClearedEvent,
  serviceManualOverrideSetEvent,
} from '@/shared/events/service.events';

/** Story 2.6 — manual status override. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `ovr-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function createService(slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: { cookie, origin: ORIGIN },
    payload: { name: slug, slug },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

function setOverride(id: string, status: string) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/services/${id}/status-override`,
    headers: { cookie, origin: ORIGIN },
    payload: { status },
  });
}

function clearOverride(id: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/services/${id}/status-override`,
    headers: { cookie, origin: ORIGIN },
  });
}

async function overrideOf(id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ manual_status_override: string | null }[]>`
      select manual_status_override from services where id = ${id}
    `;
    return rows[0]?.manual_status_override ?? null;
  });
}

async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

describe('Story 2.6: manual status override', () => {
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

  it('pins a status from the ladder and emits manual_override_set', async () => {
    const id = await createService(`${tag}-pinned`);

    const { result, captured } = await capturing(
      serviceManualOverrideSetEvent.type,
      () => setOverride(id, 'major_outage'),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { changed: true });
    assert.equal(captured.length, 1);
    assert.equal(await overrideOf(id), 'major_outage');
  });

  it('rejects a status outside the ladder at the API', async () => {
    const id = await createService(`${tag}-bogus`);

    const response = await setOverride(id, 'on_fire');

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(await overrideOf(id), null);
  });

  it('rejects a status outside the ladder at the database too', async () => {
    const id = await createService(`${tag}-constraint`);

    // The API schema is one guard; the CHECK constraint is the one that holds
    // when something writes without going through it.
    await assert.rejects(
      withTenantTransaction(orgId, async ({ sql: tx }) => {
        await tx`
          update services set manual_status_override = 'on_fire' where id = ${id}
        `;
      }),
      /services_manual_status_override_ck/,
    );
  });

  it('returns the service to computed status and emits manual_override_cleared', async () => {
    const id = await createService(`${tag}-released`);
    await setOverride(id, 'degraded');

    const { result, captured } = await capturing(
      serviceManualOverrideClearedEvent.type,
      () => clearOverride(id),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { changed: true });
    assert.equal(captured.length, 1);
    assert.equal(await overrideOf(id), null);
  });

  it('is a no-op when clearing a service that carries no override', async () => {
    const id = await createService(`${tag}-untouched`);

    const { result, captured } = await capturing(
      serviceManualOverrideClearedEvent.type,
      () => clearOverride(id),
    );

    assert.deepEqual(JSON.parse(result.body), { changed: false });
    assert.equal(
      captured.length,
      0,
      'nothing changed, so nothing is announced',
    );
  });

  it('is a no-op when setting the status the override already holds', async () => {
    const id = await createService(`${tag}-repeat`);
    await setOverride(id, 'maintenance');

    const { result, captured } = await capturing(
      serviceManualOverrideSetEvent.type,
      () => setOverride(id, 'maintenance'),
    );

    assert.deepEqual(JSON.parse(result.body), { changed: false });
    assert.equal(captured.length, 0);
  });

  it('accepts an override on an archived service without resurfacing it', async () => {
    const id = await createService(`${tag}-retired`);
    await app.inject({
      method: 'POST',
      url: `/api/v1/services/${id}/archive`,
      headers: { cookie, origin: ORIGIN },
    });

    const response = await setOverride(id, 'partial_outage');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await overrideOf(id), 'partial_outage');

    // An override says how to display a service, not whether to. Archived
    // still means absent from every list.
    for (const query of ['', '?publicOnly=true']) {
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/services${query}`,
        headers: { cookie, origin: ORIGIN },
      });
      const slugs = (JSON.parse(list.body) as { slug: string }[]).map(
        (s) => s.slug,
      );
      assert.ok(
        !slugs.includes(`${tag}-retired`),
        `still excluded for "${query}"`,
      );
    }
  });
});
