import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';

/**
 * Epic 2 retrospective, R-9: an ordinary client mistake must be refused, not
 * crash.
 *
 * Each case below returned 500 before: the request was understood and refused,
 * and the response said the server had broken. REST bodies pass TypeBox first,
 * so the GraphQL cases are the ones SDL cannot express - a format, or
 * "optional but never null".
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `inp-${randomBytes(4).toString('hex')}`;
const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';
let incidentId = '';
let windowId = '';

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

/** Refused, and refused as a client mistake rather than a server fault. */
function assertRefused(
  result: { statusCode: number; body: { errors?: { message: string }[] } },
  pattern: RegExp,
) {
  assert.ok(
    result.statusCode < 500,
    `answered ${result.statusCode}, which claims the server broke`,
  );
  const messages = (result.body.errors ?? []).map((e) => e.message).join(' | ');
  assert.match(messages, pattern);
}

describe('Input refused as a client mistake, not a crash (retrospective R-9)', () => {
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

    serviceId = JSON.parse(
      (await api('POST', '/services', { name: tag, slug: tag })).body,
    ).id;
    incidentId = JSON.parse(
      (await api('POST', '/incidents', { title: tag, impact: 'minor' })).body,
    ).id;
    windowId = JSON.parse(
      (
        await api('POST', '/maintenance', {
          title: tag,
          scheduledStartAt: new Date(Date.now() + HOUR).toISOString(),
          scheduledEndAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        })
      ).body,
    ).id;
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('refuses a service naming a group that is not in this organization', async () => {
    const response = await api('POST', '/services', {
      name: `${tag}-grouped`,
      slug: `${tag}-grouped`,
      serviceGroupId: randomUUID(),
    });

    assert.equal(response.statusCode, 400, response.body);
  });

  it('refuses the same service listed twice on an incident', async () => {
    const response = await api('POST', '/incidents', {
      title: `${tag}-dupes`,
      impact: 'major',
      affectedServices: [
        { serviceId, impact: 'major' },
        { serviceId, impact: 'minor' },
      ],
    });

    // Two rows for one service can also disagree about impact, as here.
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /more than once/i);
  });

  it('refuses the same service listed twice on a maintenance window', async () => {
    const response = await api('POST', '/maintenance', {
      title: `${tag}-dupes`,
      scheduledStartAt: new Date(Date.now() + HOUR).toISOString(),
      scheduledEndAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      affectedServiceIds: [serviceId, serviceId],
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /more than once/i);
  });

  it('refuses a whitespace-only update on the public timeline', async () => {
    const response = await api('POST', `/incidents/${incidentId}/updates`, {
      message: '   ',
    });

    assert.equal(response.statusCode, 400, response.body);
  });

  it('refuses a GraphQL date that is not a date', async () => {
    const result = await gql(
      `mutation ($input: ScheduleMaintenancePayload!) {
         scheduleMaintenance(input: $input)
       }`,
      {
        input: {
          title: `${tag}-bad-date`,
          scheduledStartAt: 'the day after tomorrow',
          scheduledEndAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        },
      },
    );

    // Invalid Date used to pass the window check, because every comparison
    // with NaN is false, and failed at the insert.
    assertRefused(result, /scheduledStartAt must be an ISO date-time/i);
  });

  it('refuses an explicit GraphQL null where a field cannot be null', async () => {
    const result = await gql(
      `mutation ($id: ID!, $input: UpdateMaintenancePayload!) {
         updateMaintenance(id: $id, input: $input)
       }`,
      { id: windowId, input: { affectedServiceIds: null } },
    );

    assertRefused(result, /affectedServiceIds cannot be null/i);
  });

  it('still lets null clear a field that is genuinely nullable', async () => {
    const result = await gql(
      `mutation ($id: ID!, $input: UpdateMaintenancePayload!) {
         updateMaintenance(id: $id, input: $input)
       }`,
      { id: windowId, input: { description: null } },
    );

    assert.deepEqual(
      result.body.errors,
      undefined,
      JSON.stringify(result.body),
    );
  });
});
