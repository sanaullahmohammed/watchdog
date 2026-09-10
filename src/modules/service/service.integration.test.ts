import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  serviceCreatedEvent,
  serviceUpdatedEvent,
} from '@/shared/events/service.events';

/**
 * Story 2.2 — create and update a service.
 *
 * Exercised over HTTP through the same instance the api entrypoint builds, so
 * the route, the command bus, the tenant transaction and RLS are all in the
 * path rather than mocked around.
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `svc-${randomBytes(4).toString('hex')}`;

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
  assert.equal(org.statusCode, 200, org.body);

  return { cookie, userId, orgId: JSON.parse(org.body).id as string };
}

function createService(cookie: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

/** Captures events of one type emitted while `run` executes. */
async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

describe('Story 2.2: create and update a service', () => {
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

  it('creates the table with RLS enabled and forced', async () => {
    const [row] = await sql<
      { rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int
               as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'services'
    `;

    assert.equal(row.rls, true);
    assert.equal(row.forced, true);
    assert.ok(row.policies >= 1);
  });

  it('does not recreate service_groups in a second migration', () => {
    const dir = join(__dirname, '../../../db/migrations');
    const creators = readdirSync(dir).filter((file) =>
      /create table\s+service_groups/i.test(
        readFileSync(join(dir, file), 'utf8'),
      ),
    );

    assert.deepEqual(
      creators.length,
      1,
      `service_groups must be created exactly once; found in ${creators.join(', ')}`,
    );
  });

  it('persists a service scoped to the organization and emits service.created', async () => {
    const { result, captured } = await capturing(serviceCreatedEvent.type, () =>
      createService(cookieA, {
        name: 'Checkout API',
        slug: `${tag}-checkout`,
        description: 'Takes the money',
        isPublic: true,
        displayOrder: 3,
      }),
    );

    assert.equal(result.statusCode, 201, result.body);
    const { id } = JSON.parse(result.body);

    assert.equal(captured.length, 1, 'service.created should be emitted once');

    const mine = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<
        { name: string; display_order: number; last_known_status: string }[]
      >`select name, display_order, last_known_status from services where id = ${id}`;
      return rows[0];
    });
    assert.equal(mine.name, 'Checkout API');
    assert.equal(mine.display_order, 3);
    assert.equal(mine.last_known_status, 'operational');

    const theirs = await withTenantTransaction(orgBId, async ({ sql: tx }) => {
      return tx`select id from services where id = ${id}`;
    });
    assert.equal(theirs.length, 0, 'another organization must not see it');
  });

  it('updates a service and emits service.updated', async () => {
    const created = await createService(cookieA, {
      name: 'Search',
      slug: `${tag}-search`,
    });
    const { id } = JSON.parse(created.body);

    const { result, captured } = await capturing(serviceUpdatedEvent.type, () =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/services/${id}`,
        headers: { cookie: cookieA, origin: ORIGIN },
        payload: { name: 'Search API', isPublic: false, displayOrder: 9 },
      }),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.equal(captured.length, 1, 'service.updated should be emitted once');

    const after = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<
        { name: string; is_public: boolean; display_order: number }[]
      >`select name, is_public, display_order from services where id = ${id}`;
      return rows[0];
    });
    assert.deepEqual(after, {
      name: 'Search API',
      is_public: false,
      display_order: 9,
    });
  });

  it('does not let another organization update a service', async () => {
    const created = await createService(cookieA, {
      name: 'Billing',
      slug: `${tag}-billing`,
    });
    const { id } = JSON.parse(created.body);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${id}`,
      headers: { cookie: cookieB, origin: ORIGIN },
      payload: { name: 'hijacked' },
    });

    // Not found rather than forbidden: confirming the row exists elsewhere
    // would itself leak across the tenant boundary.
    assert.equal(response.statusCode, 404, response.body);

    const unchanged = await withTenantTransaction(
      orgAId,
      async ({ sql: tx }) => {
        const rows = await tx<{ name: string }[]>`
        select name from services where id = ${id}
      `;
        return rows[0].name;
      },
    );
    assert.equal(unchanged, 'Billing');
  });

  it('rejects a duplicate slug, while leaving it free for other organizations', async () => {
    const slug = `${tag}-shared-slug`;

    const first = await createService(cookieA, { name: 'First', slug });
    assert.equal(first.statusCode, 201, first.body);

    const duplicate = await createService(cookieA, { name: 'Second', slug });
    assert.equal(duplicate.statusCode, 409, duplicate.body);

    const otherOrg = await createService(cookieB, { name: 'Theirs', slug });
    assert.equal(
      otherOrg.statusCode,
      201,
      'uniqueness is per organization, not global',
    );
  });

  it('keeps an archived service holding its slug', async () => {
    const slug = `${tag}-retired`;

    const created = await createService(cookieA, { name: 'Retired', slug });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = JSON.parse(created.body);

    // Archiving is Story 2.4; the state is constructed directly so that the
    // constraint's behaviour can be asserted now.
    await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      await tx`update services set archived_at = now() where id = ${id}`;
    });

    const reuse = await createService(cookieA, { name: 'Replacement', slug });

    assert.equal(
      reuse.statusCode,
      409,
      'uniqueness spans archived services, so archiving reserves the slug',
    );
  });
});
