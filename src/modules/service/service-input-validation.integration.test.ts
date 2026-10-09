import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as events from '@/shared/events/service.events';
import { type GraphqlResult, gql } from '@/shared/testing/graphql';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 9.1: GraphQL refuses what REST refuses, for services and groups.
 *
 * Each refusal asserts the field it names, that no row was written, and that
 * no service event was emitted. Where a REST route can carry the same input, a
 * control shows it is still a 400 there.
 *
 * The suite also holds the Epic 9 retro item 1a tests: the service(id)
 * malformed-id refusal, the REST-versus-GraphQL row comparison, and the
 * override-ladder refusal.
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
  method: 'POST' | 'PATCH' | 'PUT' | 'GET',
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, origin: ORIGIN },
    payload,
  });
}

/** Refused as a client mistake, with the offending field named. */
function assertRefused(
  result: GraphqlResult,
  source: 'handler' | RegExp,
  ...fields: string[]
) {
  assert.ok(result.statusCode < 500, `answered ${result.statusCode}`);
  const messages = (result.body.errors ?? []).map((e) => e.message).join(' | ');
  assert.notEqual(messages, '', 'expected an error');
  assert.doesNotMatch(messages, /Internal Server Error/);
  // Default: the handler refused. A RegExp opts into GraphQL's own type
  // check, which refuses before any handler runs, and names what it expects.
  assert.match(messages, source === 'handler' ? /^Invalid input\./ : source);
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
             service_group_id, manual_status_override, updated_at from services where id = ${serviceId}`;
    const group = await tx`
      select name, slug, display_order, updated_at
      from service_groups where id = ${groupId}`;
    return JSON.stringify([service, group]);
  });
}

/** Runs a refused operation and proves it wrote and emitted nothing. */
async function refused(run: () => Promise<GraphqlResult>, ...fields: string[]) {
  return refusedFrom('handler', run, ...fields);
}

async function refusedFrom(
  source: 'handler' | RegExp,
  run: () => Promise<GraphqlResult>,
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

const createServiceMutation = (input: object) =>
  gql(
    app,
    `mutation ($input: CreateServicePayload!) { createService(input: $input) }`,
    { cookie, variables: { input } },
  );
const updateService = (id: string, input: object) =>
  gql(
    app,
    `mutation ($id: ID!, $input: UpdateServicePayload!) {
       updateService(id: $id, input: $input)
     }`,
    { cookie, variables: { id, input } },
  );
const createServiceGroupMutation = (input: object) =>
  gql(
    app,
    `mutation ($input: CreateServiceGroupPayload!) {
       createServiceGroup(input: $input)
     }`,
    { cookie, variables: { input } },
  );
const updateGroup = (id: string, input: object) =>
  gql(
    app,
    `mutation ($id: ID!, $input: UpdateServiceGroupPayload!) {
       updateServiceGroup(id: $id, input: $input)
     }`,
    { cookie, variables: { id, input } },
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
    await refused(
      () => createServiceMutation(input),
      'name',
      'slug',
      'displayOrder',
    );
    assert.equal((await api('POST', '/services', input)).statusCode, 400);
  });

  it('refuses a name of 121 characters on create and update, services and groups', async () => {
    const name = 'n'.repeat(121);
    await refused(
      () => createServiceMutation({ name, slug: `${tag}-a` }),
      'name',
    );
    await refused(() => updateService(serviceId, { name }), 'name');
    await refused(
      () => createServiceGroupMutation({ name, slug: `${tag}-a` }),
      'name',
    );
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
      await refused(() => createServiceMutation({ name: tag, slug }), 'slug');
      await refused(
        () => createServiceGroupMutation({ name: tag, slug }),
        'slug',
      );
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
      const source =
        displayOrder === 1.5
          ? /^Variable "\$input" got invalid value 1\.5/
          : 'handler';
      const refused = (run: () => Promise<GraphqlResult>, field: string) =>
        refusedFrom(source, run, field);
      await refused(
        () =>
          createServiceMutation({ name: tag, slug: `${tag}-o`, displayOrder }),
        'displayOrder',
      );
      await refused(
        () => updateService(serviceId, { displayOrder }),
        'displayOrder',
      );
      await refused(
        () =>
          createServiceGroupMutation({
            name: tag,
            slug: `${tag}-o`,
            displayOrder,
          }),
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
        createServiceMutation({
          name: tag,
          slug: `${tag}-g`,
          serviceGroupId: 'nope',
        }),
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
      () =>
        createServiceMutation({
          name: tag,
          slug: `${tag}-n`,
          description: null,
        }),
      'description',
    );
    await refused(
      () =>
        createServiceMutation({
          name: tag,
          slug: `${tag}-n`,
          serviceGroupId: null,
        }),
      'serviceGroupId',
    );
    await refused(
      () =>
        createServiceGroupMutation({
          name: tag,
          slug: `${tag}-n`,
          displayOrder: null,
        }),
      'displayOrder',
    );
    await refused(
      () =>
        createServiceMutation({ name: tag, slug: `${tag}-n`, isPublic: null }),
      'isPublic',
    );
    await refused(
      () =>
        createServiceMutation({
          name: tag,
          slug: `${tag}-n`,
          displayOrder: null,
        }),
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
    const group = await createServiceGroupMutation({
      name: `${tag} g`,
      slug: `${tag}-cg`,
    });
    const groupRef = group.body.data as { createServiceGroup: string };
    const made = await createServiceMutation({
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
    await refused(
      () => createServiceMutation({ name, slug: `${tag}-cp` }),
      'name',
    );
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
    const result = await createServiceMutation({
      name: `${tag} ok`,
      slug: `${tag}-ok`,
      displayOrder: 3,
    });
    assert.equal(result.body.errors, undefined, JSON.stringify(result.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes(events.serviceCreatedEvent.type));
  });

  it('refuses a malformed id on a service query over GraphQL as REST does', async () => {
    const result = await gql(
      app,
      'query ($id: ID!) { service(id: $id) { id } }',
      {
        cookie,
        variables: {
          id: 'not-a-uuid',
        },
      },
    );
    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
    assert.equal(result.body.data, null);
    assert.equal(result.body.errors?.length, 1);
    assert.equal(
      result.body.errors?.[0]?.message,
      'Invalid input. id: must match format "uuid"',
    );
    assert.equal((await api('GET', '/services/not-a-uuid')).statusCode, 400);
    const unknown = await gql(
      app,
      'query ($id: ID!) { service(id: $id) { id } }',
      {
        cookie,
        variables: {
          id: randomUUID(),
        },
      },
    );
    assert.equal(unknown.statusCode, 404, JSON.stringify(unknown.body));
  });

  it('stores the same columns over REST and GraphQL', async () => {
    const columns = (id: string) =>
      withTenantTransaction(orgId, async ({ sql: tx }) => {
        const [row] = await tx`
          select name, description, is_public, display_order, service_group_id
          from services where id = ${id}`;
        return row;
      });
    const inputs = [
      {
        name: `${tag} both`,
        description: 'd',
        isPublic: false,
        displayOrder: 3,
        serviceGroupId: groupId,
      },
      { name: `${tag} min` },
    ];
    for (const [i, input] of inputs.entries()) {
      const rest = await api('POST', '/services', {
        ...input,
        slug: `${tag}-rest${i}`,
      });
      assert.equal(rest.statusCode, 201, rest.body);
      const viaGql = await createServiceMutation({
        ...input,
        slug: `${tag}-gql${i}`,
      });
      assert.equal(viaGql.body.errors, undefined, JSON.stringify(viaGql.body));
      const restRow = await columns(JSON.parse(rest.body).id);
      const gqlRow = await columns(
        (viaGql.body.data as { createService: string }).createService,
      );
      assert.deepEqual(gqlRow, restRow);
      if (i === 0) {
        assert.deepEqual(restRow, {
          name: `${tag} both`,
          description: 'd',
          is_public: false,
          display_order: 3,
          service_group_id: groupId,
        });
      } else {
        // Defaults, when only the required fields are sent.
        assert.deepEqual(restRow, {
          name: `${tag} min`,
          description: null,
          is_public: true,
          display_order: 0,
          service_group_id: null,
        });
      }
    }
  });

  it('refuses a status that is not on the ladder, over both surfaces', async () => {
    // A real override to lose: a bogus status that cleared it would show.
    const set = await api('PUT', `/services/${serviceId}/status-override`, {
      status: 'degraded',
    });
    assert.equal(set.statusCode, 200, set.body);
    await app.eventBus.drain();
    emitted.length = 0;

    await refusedFrom(
      /does not exist in "ServiceStatus"/,
      () =>
        gql(
          app,
          `mutation ($id: ID!, $input: SetStatusOverridePayload!) {
             setServiceStatusOverride(id: $id, input: $input)
           }`,
          { cookie, variables: { id: serviceId, input: { status: 'bogus' } } },
        ),
      'status',
    );
    await app.eventBus.drain();
    const countsBefore = await counts();
    const rowsBefore = await rows();
    emitted.length = 0;
    const rest = await api('PUT', `/services/${serviceId}/status-override`, {
      status: 'bogus',
    });
    await app.eventBus.drain();
    assert.equal(rest.statusCode, 400, rest.body);
    // The field the validator named, not the body: every error body carries a
    // `statusCode` key, which any match on the text would find.
    assert.deepEqual(
      JSON.parse(rest.body).subErrors.map((e: { path: string }) => e.path),
      ['/status'],
    );
    assert.equal(await counts(), countsBefore, 'a row was written');
    assert.equal(await rows(), rowsBefore, 'a row was changed');
    assert.deepEqual(emitted, [], 'an event was emitted');

    const cleared = await gql(
      app,
      `mutation ($id: ID!) { clearServiceStatusOverride(id: $id) }`,
      { cookie, variables: { id: serviceId } },
    );
    assert.equal(cleared.body.errors, undefined, JSON.stringify(cleared.body));
    await app.eventBus.drain();
  });

  it('refuses a malformed id on every service mutation, and a well-formed unknown id is not found', async () => {
    const id = 'not-a-uuid';
    const attempts = [
      () => updateService(id, { name: 'x' }),
      () => updateGroup(id, { name: 'x' }),
      () =>
        gql(app, `mutation ($id: ID!) { deleteServiceGroup(id: $id) }`, {
          cookie,
          variables: { id },
        }),
      () =>
        gql(app, `mutation ($id: ID!) { archiveService(id: $id) }`, {
          cookie,
          variables: { id },
        }),
      () =>
        gql(app, `mutation ($id: ID!) { restoreService(id: $id) }`, {
          cookie,
          variables: { id },
        }),
      () =>
        gql(
          app,
          `mutation ($id: ID!) {
             setServiceStatusOverride(id: $id, input: { status: operational })
           }`,
          { cookie, variables: { id } },
        ),
      () =>
        gql(
          app,
          `mutation ($id: ID!) { clearServiceStatusOverride(id: $id) }`,
          {
            cookie,
            variables: {
              id,
            },
          },
        ),
    ];
    for (const attempt of attempts) {
      await refused(attempt, 'id');
    }
    // A well-formed id nobody owns is still a 404, not a 400.
    const missing = await updateService(randomUUID(), { name: 'x' });
    assert.match(missing.body.errors?.[0]?.message ?? '', /not found/i);
  });
});
