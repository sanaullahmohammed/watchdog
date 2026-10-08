import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as events from '@/shared/events/incident.events';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 9.3: GraphQL refuses what REST refuses, for incidents.
 *
 * Each refusal asserts the field it names, that no row or timeline entry was
 * written or changed, and that no incident event was emitted.
 *
 * Epic 9 retro item 1c: the incidentTimeline(id) query refuses a malformed id
 * with a 400, as REST does. It is a read, so it writes nothing and does not go
 * through `refused()`.
 */

const ORIGIN = 'http://localhost:3000';
const tag = `iiv-${randomBytes(4).toString('hex')}`;
const NOT_A_UUID = 'not-a-uuid';

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';
let incidentId = '';
const emitted: string[] = [];

function api(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) {
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
    const [i] = await tx<
      { n: number }[]
    >`select count(*)::int n from incidents`;
    const [u] = await tx<
      { n: number }[]
    >`select count(*)::int n from incident_updates`;
    return `${i.n}/${u.n}`;
  });
}

/** The target incident and its impacts, every column an edit could touch. */
async function rows() {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const incident = await tx`
      select title, status, impact, started_at, updated_at
      from incidents where id = ${incidentId}`;
    const impacts = await tx`
      select service_id, impact from incident_service_impacts
      where incident_id = ${incidentId} order by service_id`;
    return JSON.stringify([incident, impacts]);
  });
}

/**
 * Runs a refused operation and proves it wrote and emitted nothing. The
 * handler's own refusal starts with `Invalid input.`; a ladder row passes
 * `graphql-type` and matches GraphQL's own enum error instead.
 */
async function refused(
  run: () => Promise<Result>,
  match: RegExp | 'handler',
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
  } else {
    assert.match(messages, match);
  }
  for (const field of fields) {
    assert.match(messages, new RegExp(`\\b${field}\\b`));
  }
  assert.equal(await counts(), countsBefore, 'a row was written');
  assert.equal(await rows(), rowsBefore, 'a row was changed');
  assert.deepEqual(emitted, [], 'an event was emitted');
}

const createIncident = (input: object) =>
  gql(
    `mutation ($input: CreateIncidentPayload!) { createIncident(input: $input) }`,
    { input },
  );
const updateIncident = (id: string, input: object) =>
  gql(
    `mutation ($id: ID!, $input: UpdateIncidentPayload!) {
       updateIncident(id: $id, input: $input)
     }`,
    { id, input },
  );
const transitionIncident = (id: string, input: object) =>
  gql(
    `mutation ($id: ID!, $input: TransitionIncidentPayload!) {
       transitionIncident(id: $id, input: $input)
     }`,
    { id, input },
  );
const postUpdate = (id: string, input: object) =>
  gql(
    `mutation ($id: ID!, $input: PostIncidentUpdatePayload!) {
       postIncidentUpdate(id: $id, input: $input)
     }`,
    { id, input },
  );

const validCreate = { title: 'Valid', impact: 'minor' };

describe('Story 9.3: GraphQL refuses what REST refuses, incidents', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    serviceId = JSON.parse(
      (await api('POST', '/services', { name: tag, slug: tag })).body,
    ).id;
    incidentId = JSON.parse(
      (await api('POST', '/incidents', { ...validCreate, title: tag })).body,
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
    assert.equal(registered.length, 7, registered.join(', '));
    assert.deepEqual(
      registered.sort(),
      [
        'incident/created',
        'incident/updated',
        'incident/confirmed',
        'incident/state_changed',
        'incident/resolved',
        'incident/dismissed',
        'incident/update_posted',
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

  it('refuses a title out of bounds on create and update', async () => {
    for (const title of ['', 'x'.repeat(201)]) {
      await refused(
        () => createIncident({ ...validCreate, title }),
        'handler',
        'title',
      );
      await refused(
        () => updateIncident(incidentId, { title }),
        'handler',
        'title',
      );
    }
    const rest = await api('POST', '/incidents', {
      ...validCreate,
      title: 'x'.repeat(201),
    });
    assert.equal(rest.statusCode, 400);
  });

  it('refuses a message out of bounds on create, transition and post', async () => {
    for (const message of ['', 'x'.repeat(4001)]) {
      await refused(
        () => createIncident({ ...validCreate, message }),
        'handler',
        'message',
      );
      await refused(
        () => transitionIncident(incidentId, { status: 'identified', message }),
        'handler',
        'message',
      );
      await refused(
        () => postUpdate(incidentId, { message }),
        'handler',
        'message',
      );
    }
    await refused(
      () => postUpdate(incidentId, { message: '   ' }),
      'handler',
      'message',
    );
  });

  it('refuses a startedAt that is not a full date-time, and REST agrees', async () => {
    for (const startedAt of [
      '2026-10-07',
      '2026-10-07T10:00:00',
      'not a date',
    ]) {
      await refused(
        () => createIncident({ ...validCreate, startedAt }),
        'handler',
        'startedAt',
      );
    }
    // Passes the format, but `Date` cannot read it: parseDate refuses it.
    await refused(
      () =>
        createIncident({ ...validCreate, startedAt: '2026-10-07T23:59:60Z' }),
      /startedAt must be an ISO date-time/,
      'startedAt',
    );
    for (const startedAt of ['2026-10-07', '2026-10-07T23:59:60Z']) {
      const rest = await api('POST', '/incidents', {
        ...validCreate,
        startedAt,
      });
      assert.equal(rest.statusCode, 400, rest.body);
      assert.match(rest.body, /startedAt/);
    }
  });

  it('refuses a service id that is not a UUID, before any lookup', async () => {
    const affectedServices = [{ serviceId: 'nope', impact: 'minor' }];
    await refused(
      () => createIncident({ ...validCreate, affectedServices }),
      'handler',
      'serviceId',
    );
    await refused(
      () => updateIncident(incidentId, { affectedServices }),
      'handler',
      'serviceId',
    );
  });

  it('refuses a malformed incident id, not a masked 500', async () => {
    await refused(
      () => updateIncident(NOT_A_UUID, { title: 'x' }),
      'handler',
      'id',
    );
    await refused(
      () => transitionIncident(NOT_A_UUID, { status: 'identified' }),
      'handler',
      'id',
    );
    await refused(
      () => postUpdate(NOT_A_UUID, { message: 'x' }),
      'handler',
      'id',
    );
  });

  it('refuses a malformed id on the incidentTimeline query over GraphQL as REST does', async () => {
    const query = 'query ($id: ID!) { incidentTimeline(id: $id) { id } }';
    const result = await gql(query, { id: NOT_A_UUID });
    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
    assert.equal(result.body.data, null);
    assert.equal(result.body.errors?.length, 1);
    assert.equal(
      result.body.errors?.[0]?.message,
      'Invalid input. id: must match format "uuid"',
    );
    const rest = await api('GET', `/incidents/${NOT_A_UUID}/updates`);
    assert.equal(rest.statusCode, 400, rest.body);
    assert.deepEqual(
      JSON.parse(rest.body).subErrors.map((e: { path: string }) => e.path),
      ['/id'],
    );
    const unknown = await gql(query, { id: randomUUID() });
    assert.equal(unknown.statusCode, 404, JSON.stringify(unknown.body));
    const found = await gql(query, { id: incidentId });
    assert.equal(found.statusCode, 200, JSON.stringify(found.body));
    const timeline = (found.body.data as { incidentTimeline: unknown[] })
      .incidentTimeline;
    assert.ok(Array.isArray(timeline) && timeline.length > 0);
  });

  it('refuses an explicit null for an optional field, and REST agrees', async () => {
    await refused(
      () => createIncident({ ...validCreate, message: null }),
      'handler',
      'message',
    );
    await refused(
      () => createIncident({ ...validCreate, startedAt: null }),
      'handler',
      'startedAt',
    );
    await refused(
      () =>
        transitionIncident(incidentId, { status: 'identified', message: null }),
      'handler',
      'message',
    );
    await refused(
      () => updateIncident(incidentId, { title: null }),
      'handler',
      'title',
    );
    await refused(
      () => createIncident({ ...validCreate, affectedServices: null }),
      'handler',
      'affectedServices',
    );
    await refused(
      () => updateIncident(incidentId, { affectedServices: null }),
      'handler',
      'affectedServices',
    );
    await refused(
      () => updateIncident(incidentId, { impact: null }),
      'handler',
      'impact',
    );

    const patchRest = await api('PATCH', `/incidents/${incidentId}`, {
      title: null,
    });
    assert.equal(patchRest.statusCode, 400);
    const createRest = await api('POST', '/incidents', {
      ...validCreate,
      message: null,
    });
    assert.equal(createRest.statusCode, 400);
    const transitionRest = await api(
      'POST',
      `/incidents/${incidentId}/transition`,
      {
        status: 'identified',
        message: null,
      },
    );
    assert.equal(transitionRest.statusCode, 400);
  });

  it('leaves a bad ladder value to GraphQL, which writes nothing', async () => {
    await refused(
      () => createIncident({ ...validCreate, impact: 'severe' }),
      /does not exist in "IncidentImpact"/,
    );
    await refused(
      () => transitionIncident(incidentId, { status: 'closed' }),
      /does not exist in "IncidentStatus"/,
    );
  });

  it('still refuses a duplicate affected service', async () => {
    const affectedServices = [
      { serviceId, impact: 'minor' },
      { serviceId, impact: 'major' },
    ];
    await refused(
      () => createIncident({ ...validCreate, affectedServices }),
      /more than once/,
    );
  });

  it('accepts valid input and emits as before', async () => {
    emitted.length = 0;
    const created = await createIncident({
      title: `${tag} full`,
      impact: 'major',
      startedAt: '2026-10-07T10:00:00Z',
      message: 'We are looking into it.',
      affectedServices: [{ serviceId, impact: 'major' }],
    });
    assert.equal(created.body.errors, undefined, JSON.stringify(created.body));
    const id = (created.body.data as { createIncident: string }).createIncident;
    await app.eventBus.drain();
    assert.ok(emitted.includes('incident/created'));

    const [row] = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ started_at: Date }[]>`
          select started_at from incidents where id = ${id}`,
    );
    assert.equal(row.started_at.toISOString(), '2026-10-07T10:00:00.000Z');

    const [impact] = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ service_id: string; impact: string }[]>`
          select service_id, impact from incident_service_impacts
          where incident_id = ${id}`,
    );
    assert.deepEqual({ ...impact }, { service_id: serviceId, impact: 'major' });
    const [opening] = await withTenantTransaction(
      orgId,
      ({ sql: tx }) =>
        tx<{ message: string }[]>`
          select message from incident_updates where incident_id = ${id}`,
    );
    assert.equal(opening.message, 'We are looking into it.');

    emitted.length = 0;
    const moved = await transitionIncident(id, {
      status: 'identified',
      message: 'Found it.',
    });
    assert.equal(moved.body.errors, undefined, JSON.stringify(moved.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes('incident/state_changed'), emitted.join());
    assert.ok(emitted.includes('incident/update_posted'), emitted.join());

    emitted.length = 0;
    const posted = await postUpdate(id, { message: 'Working on a fix.' });
    assert.equal(posted.body.errors, undefined, JSON.stringify(posted.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes('incident/update_posted'), emitted.join());

    emitted.length = 0;
    const edited = await updateIncident(id, { title: `${tag} edited` });
    assert.equal(edited.body.errors, undefined, JSON.stringify(edited.body));
    await app.eventBus.drain();
    assert.ok(emitted.includes('incident/updated'), emitted.join());
    await app.eventBus.drain();
  });
});
