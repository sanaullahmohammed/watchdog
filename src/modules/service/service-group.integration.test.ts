import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  serviceGroupCreatedEvent,
  serviceGroupDeletedEvent,
  serviceGroupUpdatedEvent,
} from '@/shared/events/service.events';

/** Story 2.3 — group services. */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `grp-${randomBytes(4).toString('hex')}`;

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

function post(url: string, cookie: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

async function capturing<T>(type: string, run: () => Promise<T>) {
  const captured: unknown[] = [];
  app.eventBus.on(type, (event) => captured.push(event));
  const result = await run();
  return { result, captured };
}

async function createGroup(cookie: string, slug: string) {
  const response = await post('/api/v1/service-groups', cookie, {
    name: slug,
    slug,
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

async function createService(cookie: string, slug: string) {
  const response = await post('/api/v1/services', cookie, { name: slug, slug });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

function assignGroup(
  cookie: string,
  serviceId: string,
  groupId: string | null,
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/services/${serviceId}`,
    headers: { cookie, origin: ORIGIN },
    payload: { serviceGroupId: groupId },
  });
}

async function groupOf(orgId: string, serviceId: string) {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ service_group_id: string | null }[]>`
      select service_group_id from services where id = ${serviceId}
    `;
    return rows[0]?.service_group_id ?? null;
  });
}

describe('Story 2.3: group services', () => {
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

  it('creates a group scoped to the organization and emits service_group.created', async () => {
    const { result, captured } = await capturing(
      serviceGroupCreatedEvent.type,
      () =>
        post('/api/v1/service-groups', cookieA, {
          name: 'Payments',
          slug: `${tag}-payments`,
        }),
    );

    assert.equal(result.statusCode, 201, result.body);
    assert.equal(captured.length, 1);

    const { id } = JSON.parse(result.body);
    const theirs = await withTenantTransaction(
      orgBId,
      ({ sql: tx }) => tx`select id from service_groups where id = ${id}`,
    );
    assert.equal(theirs.length, 0, 'another organization must not see it');
  });

  it('renames a group and emits service_group.updated', async () => {
    const id = await createGroup(cookieA, `${tag}-rename`);

    const { result, captured } = await capturing(
      serviceGroupUpdatedEvent.type,
      () =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/service-groups/${id}`,
          headers: { cookie: cookieA, origin: ORIGIN },
          payload: { name: 'Renamed', displayOrder: 7 },
        }),
    );

    assert.equal(result.statusCode, 200, result.body);
    assert.equal(captured.length, 1);

    const row = await withTenantTransaction(orgAId, async ({ sql: tx }) => {
      const rows = await tx<{ name: string; display_order: number }[]>`
        select name, display_order from service_groups where id = ${id}
      `;
      return rows[0];
    });
    assert.deepEqual(row, { name: 'Renamed', display_order: 7 });
  });

  it('ungroups rather than deletes services when a group is deleted', async () => {
    const groupId = await createGroup(cookieA, `${tag}-doomed`);
    const serviceId = await createService(cookieA, `${tag}-survivor`);
    assert.equal(
      (await assignGroup(cookieA, serviceId, groupId)).statusCode,
      200,
    );
    assert.equal(await groupOf(orgAId, serviceId), groupId);

    const { result, captured } = await capturing(
      serviceGroupDeletedEvent.type,
      () =>
        app.inject({
          method: 'DELETE',
          url: `/api/v1/service-groups/${groupId}`,
          headers: { cookie: cookieA, origin: ORIGIN },
        }),
    );

    assert.equal(result.statusCode, 204, result.body);
    assert.equal(captured.length, 1);

    // ON DELETE SET NULL (service_group_id): the service survives, ungrouped,
    // and its org_id is untouched.
    const survivor = await withTenantTransaction(
      orgAId,
      async ({ sql: tx }) => {
        const rows = await tx<
          { org_id: string; service_group_id: string | null }[]
        >`
        select org_id, service_group_id from services where id = ${serviceId}
      `;
        return rows[0];
      },
    );
    assert.deepEqual(survivor, { org_id: orgAId, service_group_id: null });
  });

  it('keeps a service in exactly one group as it moves between them', async () => {
    const first = await createGroup(cookieA, `${tag}-first`);
    const second = await createGroup(cookieA, `${tag}-second`);
    const serviceId = await createService(cookieA, `${tag}-mover`);

    assert.equal(
      (await assignGroup(cookieA, serviceId, first)).statusCode,
      200,
    );
    assert.equal(await groupOf(orgAId, serviceId), first);

    assert.equal(
      (await assignGroup(cookieA, serviceId, second)).statusCode,
      200,
    );
    assert.equal(await groupOf(orgAId, serviceId), second);

    assert.equal((await assignGroup(cookieA, serviceId, null)).statusCode, 200);
    assert.equal(await groupOf(orgAId, serviceId), null);
  });

  it('refuses to assign a service to another organization group', async () => {
    const foreignGroup = await createGroup(cookieB, `${tag}-foreign`);
    const serviceId = await createService(cookieA, `${tag}-loyal`);

    const response = await assignGroup(cookieA, serviceId, foreignGroup);

    // Refused by the composite foreign key on (service_group_id, org_id), not
    // by an application check. RLS alone would have allowed this.
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(await groupOf(orgAId, serviceId), null);
  });
});
