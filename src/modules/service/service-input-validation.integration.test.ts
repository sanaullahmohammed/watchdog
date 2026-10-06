import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as events from '@/shared/events/service.events';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 9.1: GraphQL refuses what REST refuses, for services and groups.
 *
 * Each refusal asserts the field it names, that no row was written, and that
 * no service event was emitted. Where a REST route can carry the same input, a
 * control shows it is still a 400 there.
 */

const ORIGIN = 'http://localhost:3000';
const tag = `siv-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';
let groupId = '';
const emitted: string[] = [];

function api(
  method: 'POST' | 'PATCH',
  url: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

async function gql(query: string, variables?: object) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { query, variables },
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as {
      data: unknown;
      errors?: { message: string }[];
    },
  };
}

/** Refused as a client mistake, with the offending field named. */
function assertRefused(
  result: Awaited<ReturnType<typeof gql>>,
  source: 'handler' | 'graphql-type',
  ...fields: string[]
) {
  assert.ok(result.statusCode < 500, `answered ${result.statusCode}`);
  const messages = (result.body.errors ?? []).map((e) => e.message).join(' | ');
  assert.notEqual(messages, '', 'expected an error');
  assert.doesNotMatch(messages, /Internal Server Error/);
  // Default: the handler refused. Only a fraction opts into GraphQL's own Int
  // type, which refuses before any handler runs.
  assert.match(
    messages,
    source === 'handler'
      ? /^Invalid input\./
      : /^Variable "\$input" got invalid value 1\.5/,
  );
  for (const field of fields) {
    assert.match(messages, new RegExp(`\\b${field}\\b`));
  }
}

async function counts() {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [s] = await tx<{ n: number }[]>`select count(*)::int n from services`;
    const [g] = await tx<
      { n: number }[]
    >`select count(*)::int n from service_groups`;
    return `${s.n}/${g.n}`;
  });
}

/** The target rows, every column an update could touch, so a late write shows. */
async function rows() {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const service = await tx`
      select name, slug, display_order, is_public, description,
             service_group_id, updated_at from services where id = ${serviceId}`;
    const group = await tx`
      select name, slug, display_order, updated_at
      from service_groups where id = ${groupId}`;
    return JSON.stringify([service, group]);
  });
}

/** Runs a refused operation and proves it wrote and emitted nothing. */
async function refused(run: () => ReturnType<typeof gql>, ...fields: string[]) {
  return refusedFrom('handler', run, ...fields);
}

async function refusedFrom(
  source: 'handler' | 'graphql-type',
  run: () => ReturnType<typeof gql>,
  ...fields: string[]
) {
  await app.eventBus.drain();
  const before = await counts();
  const rowsBefore = await rows();
  emitted.length = 0;
  const result = await run();
  await app.eventBus.drain();
  assertRefused(result, source, ...fields);
  assert.equal(await counts(), before, 'a row was written');
  assert.equal(await rows(), rowsBefore, 'a row was changed');
  assert.deepEqual(emitted, [], 'an event was emitted');
}

const createService = (input: object) =>
  gql(
    `mutation ($input: CreateServicePayload!) { createService(input: $input) }`,
    { input },
  );
const updateService = (id: string, input: object) =>
  gql(
    `mutation ($id: ID!, $input: UpdateServicePayload!) {
       updateService(id: $id, input: $input)
     }`,
    { id, input },
  );
const createGroup = (input: object) =>
  gql(
    `mutation ($input: CreateServiceGroupPayload!) {
       createServiceGroup(input: $input)
     }`,
    { input },
  );
const updateGroup = (id: string, input: object) =>
  gql(
    `mutation ($id: ID!, $input: UpdateServiceGroupPayload!) {
       updateServiceGroup(id: $id, input: $input)
     }`,
    { id, input },
  );

describe('Story 9.1: GraphQL refuses what REST refuses, services and groups', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    serviceId = JSON.parse(
      (await api('POST', '/services', { name: tag, slug: tag })).body,
    ).id;
    groupId = JSON.parse(
      (await api('POST', '/service-groups', { name: tag, slug: tag })).body,
    ).id;
    const registered: string[] = [];
    for (const creator of Object.values(events)) {
      if (typeof creator === 'function' && 'type' in creator) {
        registered.push(creator.type as string);
        app.eventBus.on(creator.type as string, (e: { type: string }) =>
          emitted.push(e.type),
        );
      }
    }
    // "No event" proves nothing if a type was never listened for.
    assert.deepEqual(
      registered.sort(),
      [
        'service/created',
        'service/updated',
        'service/manual_override_set',
        'service/manual_override_cleared',
        'service/archived',
        'service/restored',
        'service/status_changed',
        'service_group/created',
        'service_group/updated',
        'service_group/deleted',
      ].sort(),
    );
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('refuses name, slug and displayOrder together, and REST answers 400', async () => {
    const input = { name: '', slug: 'INVALID SLUG!', displayOrder: -1 };
    await refused(() => createService(input), 'name', 'slug', 'displayOrder');
    assert.equal((await api('POST', '/services', input)).statusCode, 400);
  });

  it('refuses a name of 121 characters on create and update, services and groups', async () => {
    const name = 'n'.repeat(121);
    await refused(() => createService({ name, slug: `${tag}-a` }), 'name');
    await refused(() => updateService(serviceId, { name }), 'name');
    await refused(() => createGroup({ name, slug: `${tag}-a` }), 'name');
    await refused(() => updateGroup(groupId, { name }), 'name');
    assert.equal(
      (await api('POST', '/services', { name, slug: `${tag}-a` })).statusCode,
      400,
    );
    assert.equal(
      (await api('PATCH', `/services/${serviceId}`, { name })).statusCode,
      400,
    );
  });

  it('refuses a bad slug: a space, a leading hyphen, 121 characters', async () => {
    for (const slug of ['Has Space', '-lead', 'a'.repeat(121)]) {
      await refused(() => createService({ name: tag, slug }), 'slug');
      await refused(() => createGroup({ name: tag, slug }), 'slug');
      await refused(() => updateGroup(groupId, { slug }), 'slug');
      assert.equal(
        (await api('POST', '/services', { name: tag, slug })).statusCode,
        400,
      );
      assert.equal(
        (await api('PATCH', `/service-groups/${groupId}`, { slug })).statusCode,
        400,
      );
    }
  });

  it('refuses a negative or fractional displayOrder', async () => {
    for (const displayOrder of [-1, 1.5]) {
      const source = displayOrder === 1.5 ? 'graphql-type' : 'handler';
      const refused = (run: () => ReturnType<typeof gql>, field: string) =>
        refusedFrom(source, run, field);
      await refused(
        () => createService({ name: tag, slug: `${tag}-o`, displayOrder }),
        'displayOrder',
      );
      await refused(
        () => updateService(serviceId, { displayOrder }),
        'displayOrder',
      );
      await refused(
        () => createGroup({ name: tag, slug: `${tag}-o`, displayOrder }),
        'displayOrder',
      );
      await refused(
        () => updateGroup(groupId, { displayOrder }),
        'displayOrder',
      );
      assert.equal(
        (await api('PATCH', `/services/${serviceId}`, { displayOrder }))
          .statusCode,
        400,
      );
    }
  });

  it('refuses a group id that is not a uuid on create and update', async () => {
    await refused(
      () =>
        createService({ name: tag, slug: `${tag}-g`, serviceGroupId: 'nope' }),
      'serviceGroupId',
    );
    await refused(
      () => updateService(serviceId, { serviceGroupId: 'nope' }),
      'serviceGroupId',
    );
    assert.equal(
      (
        await api('POST', '/services', {
          name: tag,
          slug: `${tag}-g`,
          serviceGroupId: 'nope',
        })
      ).statusCode,
      400,
    );
  });

  it('refuses null on create for service description, serviceGroupId, isPublic and displayOrder, and group displayOrder', async () => {
    await refused(
      () => createService({ name: tag, slug: `${tag}-n`, description: null }),
      'description',
    );
    await refused(
      () =>
        createService({ name: tag, slug: `${tag}-n`, serviceGroupId: null }),
      'serviceGroupId',
    );
    await refused(
      () => createGroup({ name: tag, slug: `${tag}-n`, displayOrder: null }),
      'displayOrder',
    );
    await refused(
      () => createService({ name: tag, slug: `${tag}-n`, isPublic: null }),
      'isPublic',
    );
    await refused(
      () => createService({ name: tag, slug: `${tag}-n`, displayOrder: null }),
      'displayOrder',
    );
    assert.equal(
      (
        await api('POST', '/services', {
          name: tag,
          slug: `${tag}-n`,
          serviceGroupId: null,
        })
      ).statusCode,
      400,
    );
  });

  it('refuses null for name, isPublic, displayOrder and slug on update', async () => {
    await refused(() => updateService(serviceId, { name: null }), 'name');
    await refused(
      () => updateService(serviceId, { isPublic: null }),
      'isPublic',
    );
    await refused(
      () => updateService(serviceId, { displayOrder: null }),
      'displayOrder',
    );
    await refused(() => updateGroup(groupId, { name: null }), 'name');
    await refused(() => updateGroup(groupId, { slug: null }), 'slug');
    await refused(
      () => updateGroup(groupId, { displayOrder: null }),
      'displayOrder',
    );
  });

  it('accepts null on update, clearing a description and a group', async () => {
    const group = await createGroup({ name: `${tag} g`, slug: `${tag}-cg` });
    const groupRef = group.body.data as { createServiceGroup: string };
    const made = await createService({
      name: `${tag} c`,
      slug: `${tag}-c`,
      description: 'something',
      serviceGroupId: groupRef.createServiceGroup,
    });
    assert.equal(made.body.errors, undefined, JSON.stringify(made.body));
    const id = (made.body.data as { createService: string }).createService;
    const read = () =>
      withTenantTransaction(orgId, async ({ sql: tx }) => {
        const [row] = await tx<
          { description: string | null; service_group_id: string | null }[]
        >`select description, service_group_id from services where id = ${id}`;
        return row;
      });
    const before = await read();
    assert.equal(before.description, 'something');
    assert.equal(before.service_group_id, groupRef.createServiceGroup);

    const result = await updateService(id, {
      description: null,
      serviceGroupId: null,
    });
    assert.equal(result.body.errors, undefined, JSON.stringify(result.body));
    const after = await read();
    assert.equal(after.description, null);
    assert.equal(after.service_group_id, null);
  });

  it('refuses a name of one letter and 200 combining marks, as REST does', async () => {
    const name = `a${'\u0301'.repeat(200)}`;
    await refused(() => createService({ name, slug: `${tag}-cp` }), 'name');
    assert.equal(
      (await api('POST', '/services', { name, slug: `${tag}-cp` })).statusCode,
      400,
    );
  });

  it('answers 400 over REST to a bad group id, a long group name and a malformed path id', async () => {
    assert.equal(
      (
        await api('POST', '/services', {
          name: tag,
          slug: `${tag}-rg`,
          serviceGroupId: 'nope',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await api('POST', '/service-groups', {
          name: 'n'.repeat(121),
          slug: `${tag}-rg`,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await api('PATCH', '/services/not-a-uuid', { name: 'x' })).statusCode,
      400,
    );
  });

  it('accepts valid input and emits service.created', async () => {
    await app.eventBus.drain();
    emitted.length = 0;
    const result = await createService({
      name: `${tag} ok`,
      slug: `${tag}-ok`,
      displayOrder: 3,
    });
    assert.equal(result.body.errors, undefined, JSON.stringify(result.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes(events.serviceCreatedEvent.type));
  });

  it('refuses a malformed id on every service mutation, and a well-formed unknown id is not found', async () => {
    const id = 'not-a-uuid';
    const attempts = [
      () => updateService(id, { name: 'x' }),
      () => updateGroup(id, { name: 'x' }),
      () => gql(`mutation ($id: ID!) { deleteServiceGroup(id: $id) }`, { id }),
      () => gql(`mutation ($id: ID!) { archiveService(id: $id) }`, { id }),
      () => gql(`mutation ($id: ID!) { restoreService(id: $id) }`, { id }),
      () =>
        gql(
          `mutation ($id: ID!) {
             setServiceStatusOverride(id: $id, input: { status: operational })
           }`,
          { id },
        ),
      () =>
        gql(`mutation ($id: ID!) { clearServiceStatusOverride(id: $id) }`, {
          id,
        }),
    ];
    for (const attempt of attempts) {
      await refused(attempt, 'id');
    }
    // A well-formed id nobody owns is still a 404, not a 400.
    const missing = await updateService(randomUUID(), { name: 'x' });
    assert.match(missing.body.errors?.[0]?.message ?? '', /not found/i);
  });
});
