import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import {
  createMonitor,
  createService,
  setMonitorCheckState,
} from '@/shared/testing/fixtures';
import { gql, gqlData } from '@/shared/testing/graphql';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/** Story 5.2: list a service's monitors over REST and GraphQL. */

const tag = `rdm-${randomBytes(4).toString('hex')}`;
const FIELDS = `id serviceId type name target intervalSeconds timeoutSeconds
  failureThreshold enabled config { keyword warnDays } consecutiveFailures
  lastCheckedAt`;
const LIST = `query ($id: ID!) { monitors(serviceId: $id) { ${FIELDS} } }`;

let app: FastifyInstance;
let a: Awaited<ReturnType<typeof signUpWithOrg>>;
let b: Awaited<ReturnType<typeof signUpWithOrg>>;

const restList = (serviceId: string, cookie = a.cookie) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/services/${serviceId}/monitors`,
    headers: cookie ? { cookie, origin: TEST_ORIGIN } : {},
  });

const gqlList = async (serviceId: string, cookie = a.cookie) =>
  (
    await gqlData<{ monitors: unknown[] }>(app, LIST, {
      variables: { id: serviceId },
      cookie,
    })
  ).monitors;

describe('List a service monitors (story 5.2)', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    a = await signUpWithOrg(app, `${tag}-a`);
    b = await signUpWithOrg(app, `${tag}-b`);
  });

  after(async () => {
    await app.eventBus.drain();
    for (const t of [a, b]) {
      await sql`delete from "organization" where "id" = ${t.orgId}`;
      await sql`delete from "user" where "id" = ${t.userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('lists every monitor with its config and counters, over both surfaces', async () => {
    const serviceId = await createService(app, a.cookie);
    const tcp = await createMonitor(app, a.cookie, serviceId, {
      name: 'd-tcp',
      type: 'tcp',
      target: '203.0.113.10:443',
    });
    const ssl = await createMonitor(app, a.cookie, serviceId, {
      name: 'c-ssl',
      type: 'ssl_expiry',
      target: '203.0.113.10',
      config: { warnDays: 14 },
      enabled: false,
    });
    const keyword = await createMonitor(app, a.cookie, serviceId, {
      name: 'b-keyword',
      type: 'keyword',
      config: { keyword: 'ok' },
    });
    const http = await createMonitor(app, a.cookie, serviceId, {
      name: 'a-http',
    });
    const checkedAt = new Date('2026-10-01T12:00:00.000Z');
    await setMonitorCheckState(a.orgId, tcp, {
      consecutiveFailures: 2,
      lastCheckedAt: checkedAt,
    });

    const response = await restList(serviceId);
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body) as Record<string, unknown>[];

    assert.deepEqual(
      body.map((m) => m.id),
      [http, keyword, ssl, tcp],
    );
    assert.deepEqual(body[0].config, { keyword: null, warnDays: null });
    assert.deepEqual(body[1].config, { keyword: 'ok', warnDays: null });
    assert.deepEqual(body[2].config, { keyword: null, warnDays: 14 });
    assert.equal(body[2].enabled, false);
    assert.equal(body[3].consecutiveFailures, 2);
    assert.equal(body[3].lastCheckedAt, checkedAt.toISOString());
    assert.equal(body[0].lastCheckedAt, null);
    assert.equal(body[0].serviceId, serviceId);
    assert.deepEqual(Object.keys(body[0]).sort(), [
      'config',
      'consecutiveFailures',
      'enabled',
      'failureThreshold',
      'id',
      'intervalSeconds',
      'lastCheckedAt',
      'name',
      'serviceId',
      'target',
      'timeoutSeconds',
      'type',
    ]);

    assert.deepEqual(await gqlList(serviceId), body);
  });

  it('orders monitors with the same name by id, on every request', async () => {
    const serviceId = await createService(app, a.cookie);
    // Keep creating until creation order differs from id order, so dropping
    // `id asc` cannot pass by chance.
    const created: string[] = [];
    for (let i = 0; i < 20; i++) {
      created.push(
        await createMonitor(app, a.cookie, serviceId, { name: 'same' }),
      );
      if (created.length >= 3 && created.join() !== [...created].sort().join())
        break;
    }
    assert.notDeepEqual(created, [...created].sort(), 'precondition');
    const first = JSON.parse((await restList(serviceId)).body) as {
      id: string;
    }[];
    const second = JSON.parse((await restList(serviceId)).body) as {
      id: string;
    }[];

    assert.equal(first.length, created.length);
    assert.deepEqual(
      first.map((m) => m.id),
      [...first.map((m) => m.id)].sort(),
    );
    assert.deepEqual(second, first);
  });

  it('answers an empty list for a service with no monitors', async () => {
    const serviceId = await createService(app, a.cookie);
    const response = await restList(serviceId);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), []);
    assert.deepEqual(await gqlList(serviceId), []);
  });

  it('answers an empty list for a service of another organization', async () => {
    const serviceId = await createService(app, b.cookie);
    await createMonitor(app, b.cookie, serviceId);

    const response = await restList(serviceId);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), []);
    assert.deepEqual(await gqlList(serviceId), []);
    assert.equal((await gqlList(serviceId, b.cookie)).length, 1);
  });

  it('answers an empty list for a service id that does not exist', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    assert.deepEqual(JSON.parse((await restList(id)).body), []);
    assert.deepEqual(await gqlList(id), []);
  });

  it('lists the monitors of an archived service', async () => {
    const serviceId = await createService(app, a.cookie);
    const id = await createMonitor(app, a.cookie, serviceId);
    const archive = await app.inject({
      method: 'POST',
      url: `/api/v1/services/${serviceId}/archive`,
      headers: { cookie: a.cookie, origin: TEST_ORIGIN },
    });
    assert.equal(archive.statusCode, 200, archive.body);

    const body = JSON.parse((await restList(serviceId)).body) as {
      id: string;
    }[];
    assert.deepEqual(
      body.map((m) => m.id),
      [id],
    );
  });

  it('refuses a malformed service id with 400 on both surfaces', async () => {
    const response = await restList('not-a-uuid');
    assert.equal(response.statusCode, 400, response.body);

    const result = await gql(app, LIST, {
      variables: { id: 'not-a-uuid' },
      cookie: a.cookie,
    });
    assert.equal(result.statusCode, 400);
    assert.match(
      result.body.errors?.[0]?.message ?? '',
      /^Invalid input\. (?:.*; )?serviceId: /,
    );
  });

  it('refuses a request with no session', async () => {
    const serviceId = await createService(app, a.cookie);
    const response = await restList(serviceId, '');
    assert.equal(response.statusCode, 401, response.body);

    const result = await gql(app, LIST, { variables: { id: serviceId } });
    assert.equal(result.body.data, null);
    assert.equal(result.body.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
  });
});
