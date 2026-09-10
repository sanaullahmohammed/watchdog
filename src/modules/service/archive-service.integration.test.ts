import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  serviceArchivedEvent,
  serviceRestoredEvent,
} from '@/shared/events/service.events';

/**
 * Story 2.4 — archive and restore.
 *
 * The monitor half of FR4's archive semantics is not asserted here. DOMAIN.md
 * is explicit that archiving writes nothing to monitors: suspension is the
 * worker's due-monitor query filtering `archived_at IS NULL`, which Epic 5
 * builds and must verify.
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `arc-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';

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
  assert.equal(signUp.statusCode, 200, signUp.body);
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
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

function act(cookie: string, id: string, verb: 'archive' | 'restore') {
  return app.inject({
    method: 'POST',
    url: `/api/v1/services/${id}/${verb}`,
    headers: { cookie, origin: ORIGIN },
  });
}

async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

function rowOf(orgId: string, id: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<
      {
        archived_at: Date | null;
        name: string;
        slug: string;
        service_group_id: string | null;
      }[]
    >`select archived_at, name, slug, service_group_id from services where id = ${id}`;
    return rows[0];
  });
}

describe('Story 2.4: archive and restore a service', () => {
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
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('sets archived_at, emits service.archived, and keeps the row', async () => {
    const id = await createService(cookieA, `${tag}-retire`);

    const { result, captured } = await capturing(
      serviceArchivedEvent.type,
      () => act(cookieA, id, 'archive'),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { changed: true });
    assert.equal(captured.length, 1);

    const row = await rowOf(orgAId, id);
    assert.ok(
      row,
      'the row must survive; archiving is an update, not a delete',
    );
    assert.ok(row.archived_at instanceof Date);
  });

  it('clears archived_at and emits service.restored', async () => {
    const id = await createService(cookieA, `${tag}-revive`);
    await act(cookieA, id, 'archive');

    const { result, captured } = await capturing(
      serviceRestoredEvent.type,
      () => act(cookieA, id, 'restore'),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { changed: true });
    assert.equal(captured.length, 1);
    assert.equal((await rowOf(orgAId, id)).archived_at, null);
  });

  it('leaves a service intact, including its associations', async () => {
    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/service-groups',
      headers: { cookie: cookieA, origin: ORIGIN },
      payload: { name: 'Kept', slug: `${tag}-kept` },
    });
    const groupId = JSON.parse(group.body).id;

    const id = await createService(cookieA, `${tag}-history`);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: { cookie: cookieA, origin: ORIGIN },
      payload: { serviceGroupId: groupId },
    });

    await act(cookieA, id, 'archive');

    // Archiving is an UPDATE. Nothing about the row or what it points at is
    // destroyed, which is the mechanism by which incidents and uptime history
    // stay readable once those tables exist.
    const row = await rowOf(orgAId, id);
    assert.equal(row.name, `${tag}-history`);
    assert.equal(row.slug, `${tag}-history`);
    assert.equal(row.service_group_id, groupId);
  });

  it('is a no-op when the service is already archived', async () => {
    const id = await createService(cookieA, `${tag}-twice`);
    await act(cookieA, id, 'archive');
    const firstArchivedAt = (await rowOf(orgAId, id)).archived_at;

    const { result, captured } = await capturing(
      serviceArchivedEvent.type,
      () => act(cookieA, id, 'archive'),
    );

    assert.deepEqual(JSON.parse(result.body), { changed: false });
    assert.equal(captured.length, 0, 'no second service.archived');
    assert.deepEqual(
      (await rowOf(orgAId, id)).archived_at,
      firstArchivedAt,
      'the original archive time must not be overwritten',
    );
  });

  it('is a no-op when restoring a service that is not archived', async () => {
    const id = await createService(cookieA, `${tag}-live`);

    const { result, captured } = await capturing(
      serviceRestoredEvent.type,
      () => act(cookieA, id, 'restore'),
    );

    assert.deepEqual(JSON.parse(result.body), { changed: false });
    assert.equal(captured.length, 0, 'no service.restored');
  });

  it('does not let another organization archive a service', async () => {
    const id = await createService(cookieA, `${tag}-guarded`);

    const response = await act(cookieB, id, 'archive');

    assert.equal(response.statusCode, 404, response.body);
    assert.equal((await rowOf(orgAId, id)).archived_at, null);
  });
});
