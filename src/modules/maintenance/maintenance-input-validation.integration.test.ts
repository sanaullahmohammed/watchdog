import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as events from '@/shared/events/maintenance.events';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 9.4: GraphQL refuses what REST refuses, for maintenance.
 *
 * Each refusal asserts the field it names, that no row or affected service was
 * written or changed, and that no maintenance event was emitted.
 */

const ORIGIN = 'http://localhost:3000';
const HOUR = 60 * 60 * 1000;
const tag = `miv-${randomBytes(4).toString('hex')}`;
const NOT_A_UUID = 'not-a-uuid';
const LEAP_SECOND = '2026-10-07T23:59:60Z';

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';
let otherServiceId = '';
let windowId = '';
const emitted: string[] = [];

const iso = (hours: number) =>
  new Date(Date.now() + hours * HOUR).toISOString();

function api(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, origin: ORIGIN },
    payload: payload as Record<string, unknown> | undefined,
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

type Result = Awaited<ReturnType<typeof gql>>;

function messagesOf(result: Result) {
  assert.ok(result.statusCode < 500, `answered ${result.statusCode}`);
  const messages = (result.body.errors ?? []).map((e) => e.message).join(' | ');
  assert.notEqual(messages, '', 'expected an error');
  assert.doesNotMatch(messages, /Internal Server Error/);
  return messages;
}

async function counts() {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const [m] = await tx<
      { n: number }[]
    >`select count(*)::int n from maintenance`;
    const [s] = await tx<
      { n: number }[]
    >`select count(*)::int n from maintenance_services`;
    return `${m.n}/${s.n}`;
  });
}

/** The target window and its services, every column an edit could touch. */
async function rows() {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const window = await tx`
      select title, description, status, scheduled_start_at,
             scheduled_end_at, updated_at
      from maintenance where id = ${windowId}`;
    const services = await tx`
      select service_id from maintenance_services
      where maintenance_id = ${windowId} order by service_id`;
    return JSON.stringify([window, services]);
  });
}

/**
 * Runs a refused operation and proves it wrote and emitted nothing. A refusal
 * from the handler starts with `Invalid input.`; `fieldOnly` is for a value the
 * schema passes and `parseDate` refuses with its own message.
 */
async function refused(
  run: () => Promise<Result>,
  match: 'handler' | 'fieldOnly' | RegExp,
  ...fields: string[]
) {
  await app.eventBus.drain();
  const countsBefore = await counts();
  const rowsBefore = await rows();
  emitted.length = 0;
  const result = await run();
  await app.eventBus.drain();
  const messages = messagesOf(result);
  if (match === 'handler') {
    assert.match(messages, /^Invalid input\./);
  } else if (match instanceof RegExp) {
    assert.match(messages, match);
  }
  for (const field of fields) {
    assert.match(messages, new RegExp(`\\b${field}\\b`));
  }
  assert.equal(await counts(), countsBefore, 'a row was written');
  assert.equal(await rows(), rowsBefore, 'a row was changed');
  assert.deepEqual(emitted, [], 'an event was emitted');
}

const schedule = (input: object) =>
  gql(
    `mutation ($input: ScheduleMaintenancePayload!) { scheduleMaintenance(input: $input) }`,
    { input },
  );
const update = (id: string, input: object) =>
  gql(
    `mutation ($id: ID!, $input: UpdateMaintenancePayload!) {
       updateMaintenance(id: $id, input: $input)
     }`,
    { id, input },
  );
const complete = (id: string) =>
  gql(`mutation ($id: ID!) { completeMaintenance(id: $id) }`, { id });
const remove = (id: string) =>
  gql(`mutation ($id: ID!) { deleteMaintenance(id: $id) }`, { id });

const validSchedule = () => ({
  title: 'Valid',
  scheduledStartAt: iso(24),
  scheduledEndAt: iso(26),
});

async function createWindow(title: string, serviceIds: string[]) {
  const response = await api('POST', '/maintenance', {
    title,
    scheduledStartAt: iso(24),
    scheduledEndAt: iso(26),
    affectedServiceIds: serviceIds,
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

describe('Story 9.4: GraphQL refuses what REST refuses, maintenance', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    const createService = async (slug: string) => {
      const response = await api('POST', '/services', { name: slug, slug });
      assert.equal(response.statusCode, 201, response.body);
      return JSON.parse(response.body).id as string;
    };
    serviceId = await createService(tag);
    otherServiceId = await createService(`${tag}-b`);
    windowId = await createWindow(tag, [serviceId]);
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
        'maintenance/created',
        'maintenance/updated',
        'maintenance/started',
        'maintenance/completed',
        'maintenance/deleted',
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

  it('refuses a title out of bounds on schedule and update, and REST agrees', async () => {
    for (const title of ['', 'x'.repeat(201)]) {
      await refused(
        () => schedule({ ...validSchedule(), title }),
        'handler',
        'title',
      );
      await refused(() => update(windowId, { title }), 'handler', 'title');
    }
    const rest = await api('POST', '/maintenance', {
      ...validSchedule(),
      title: 'x'.repeat(201),
    });
    assert.equal(rest.statusCode, 400, rest.body);
  });

  it('refuses a date that is not a full date-time, and REST agrees', async () => {
    for (const value of [
      '2026-10-07',
      '2026-10-07T10:00:00',
      'Oct 7 2026',
      'the day after tomorrow',
    ]) {
      await refused(
        () => schedule({ ...validSchedule(), scheduledStartAt: value }),
        'handler',
        'scheduledStartAt',
      );
      await refused(
        () => update(windowId, { scheduledStartAt: value }),
        'handler',
        'scheduledStartAt',
      );
    }
    const rest = await api('POST', '/maintenance', {
      ...validSchedule(),
      scheduledStartAt: '2026-10-07',
    });
    assert.equal(rest.statusCode, 400, rest.body);
  });

  it('refuses a leap second with a 400 on both surfaces', async () => {
    await refused(
      () => schedule({ ...validSchedule(), scheduledEndAt: LEAP_SECOND }),
      'fieldOnly',
      'scheduledEndAt',
    );
    await refused(
      () => update(windowId, { scheduledEndAt: LEAP_SECOND }),
      'fieldOnly',
      'scheduledEndAt',
    );
    const restSchedule = await api('POST', '/maintenance', {
      ...validSchedule(),
      scheduledEndAt: LEAP_SECOND,
    });
    assert.equal(restSchedule.statusCode, 400, restSchedule.body);
    const restUpdate = await api('PATCH', `/maintenance/${windowId}`, {
      scheduledEndAt: LEAP_SECOND,
    });
    assert.equal(restUpdate.statusCode, 400, restUpdate.body);
  });

  it('refuses a service id that is not a UUID, before any lookup', async () => {
    await refused(
      () => schedule({ ...validSchedule(), affectedServiceIds: ['nope'] }),
      'handler',
      'affectedServiceIds',
    );
    await refused(
      () => update(windowId, { affectedServiceIds: ['nope'] }),
      'handler',
      'affectedServiceIds',
    );
  });

  it('refuses a malformed window id, not a masked 500', async () => {
    await refused(() => update(NOT_A_UUID, { title: 'x' }), 'handler', 'id');
    await refused(() => complete(NOT_A_UUID), 'handler', 'id');
    await refused(() => remove(NOT_A_UUID), 'handler', 'id');
    const rest = await api('POST', `/maintenance/${NOT_A_UUID}/complete`);
    assert.equal(rest.statusCode, 400, rest.body);
  });

  it('refuses a null date on update, and REST agrees', async () => {
    await refused(
      () => update(windowId, { scheduledStartAt: null }),
      'handler',
      'scheduledStartAt',
    );
    await refused(
      () => update(windowId, { scheduledEndAt: null }),
      'handler',
      'scheduledEndAt',
    );
    const rest = await api('PATCH', `/maintenance/${windowId}`, {
      scheduledStartAt: null,
    });
    assert.equal(rest.statusCode, 400, rest.body);
  });

  it('still refuses a null on every other non-nullable field', async () => {
    await refused(() => update(windowId, { title: null }), 'handler', 'title');
    await refused(
      () => update(windowId, { affectedServiceIds: null }),
      'handler',
      'affectedServiceIds',
    );
    await refused(
      () => schedule({ ...validSchedule(), affectedServiceIds: null }),
      'handler',
      'affectedServiceIds',
    );
  });

  it('still refuses a duplicate affected service', async () => {
    await refused(
      () =>
        schedule({
          ...validSchedule(),
          affectedServiceIds: [serviceId, serviceId],
        }),
      /more than once/,
    );
  });

  it('accepts valid input and emits as before', async () => {
    emitted.length = 0;
    const created = await schedule({
      ...validSchedule(),
      title: `${tag} full`,
      description: 'Planned.',
      affectedServiceIds: [serviceId, otherServiceId],
    });
    assert.equal(created.body.errors, undefined, JSON.stringify(created.body));
    const id = (created.body.data as { scheduleMaintenance: string })
      .scheduleMaintenance;
    await app.eventBus.drain();
    assert.ok(emitted.includes('maintenance/created'), emitted.join());
    const stored = await withTenantTransaction(orgId, async ({ sql: tx }) => {
      const [w] = await tx<{ title: string }[]>`
        select title from maintenance where id = ${id}`;
      const s = await tx`
        select service_id from maintenance_services where maintenance_id = ${id}`;
      return { title: w.title, services: s.length };
    });
    assert.deepEqual(stored, { title: `${tag} full`, services: 2 });

    emitted.length = 0;
    const edited = await update(id, {
      title: `${tag} edited`,
      scheduledStartAt: iso(48),
      scheduledEndAt: iso(50),
    });
    assert.equal(edited.body.errors, undefined, JSON.stringify(edited.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes('maintenance/updated'), emitted.join());

    emitted.length = 0;
    const cleared = await update(id, { description: null });
    assert.equal(cleared.body.errors, undefined, JSON.stringify(cleared.body));
    const [row] = await withTenantTransaction(
      orgId,
      ({ sql: tx }) => tx<{ description: string | null }[]>`
        select description from maintenance where id = ${id}`,
    );
    assert.equal(row.description, null);
    await app.eventBus.drain();

    emitted.length = 0;
    const done = await complete(id);
    assert.equal(done.body.errors, undefined, JSON.stringify(done.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes('maintenance/completed'), emitted.join());

    const doomed = await createWindow(`${tag} doomed`, [serviceId]);
    emitted.length = 0;
    const gone = await remove(doomed);
    assert.equal(gone.body.errors, undefined, JSON.stringify(gone.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes('maintenance/deleted'), emitted.join());
  });
});
