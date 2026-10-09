import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { parseAllowedCidrs } from '@/config/allowed-cidrs';
import config from '@/config/env';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as monitorEvents from '@/shared/events/monitor.events';
import { createMonitor, createService } from '@/shared/testing/fixtures';
import { type GraphqlResult, gql } from '@/shared/testing/graphql';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 5.1: both surfaces refuse an invalid or unsafe monitor with a 400 that
 * names the field, before any SQL or emit.
 */

const tag = `miv-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let serviceId = '';
let monitorId = '';
const emitted: string[] = [];

const GOOD = {
  type: 'http',
  name: tag,
  target: 'https://203.0.113.10/health',
};

const createRest = (input: object) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/monitors',
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { serviceId, ...input },
  });

const updateRest = (input: object) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/monitors/${monitorId}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload: input,
  });

const createGql = (input: object) =>
  gql(
    app,
    `mutation ($input: CreateMonitorPayload!) { createMonitor(input: $input) }`,
    { cookie, variables: { input: { serviceId, ...input } } },
  );

const updateGql = (input: object) =>
  gql(
    app,
    `mutation ($id: ID!, $input: UpdateMonitorPayload!) { updateMonitor(id: $id, input: $input) }`,
    { cookie, variables: { id: monitorId, input } },
  );

/** Refused over GraphQL only: REST would not see the null at all. */
async function refusedGqlOnly(pending: Promise<GraphqlResult>, field: string) {
  await app.eventBus.drain();
  const before = await snapshot();
  emitted.length = 0;
  assertRefusedGql(await pending, field);
  await app.eventBus.drain();
  assert.equal(await snapshot(), before, 'a row was written');
  assert.deepEqual(emitted, [], 'an event was emitted');
}

async function snapshot() {
  return withTenantTransaction(orgId, async ({ sql: tx }) =>
    JSON.stringify(await tx`select * from monitors order by id`),
  );
}

function assertRefusedGql(result: GraphqlResult, field: string) {
  assert.ok(result.statusCode < 500, `answered ${result.statusCode}`);
  const messages = (result.body.errors ?? []).map((e) => e.message).join(' | ');
  assert.match(messages, /^Invalid input\./, messages);
  assert.match(messages, new RegExp(`(^|; |\\. )${field}: `), messages);
}

/**
 * A REST 400 names the field structurally: in the message (the domain's rules)
 * or in a validation error's path (what the schema states), never as a loose
 * substring of the body.
 */
function assertRestNames(body: string, field: string) {
  const parsed = JSON.parse(body) as {
    message?: string;
    subErrors?: Array<{ path?: string; message?: string }>;
  };
  const leaf = field.split('/').pop() as string;
  const inMessage = new RegExp(`(^|; |\\. )${field}: `).test(
    parsed.message ?? '',
  );
  const inPath = (parsed.subErrors ?? []).some(
    (error) =>
      error.path === `/${field}` ||
      (error.path ?? '').endsWith(`/${leaf}`) ||
      new RegExp(`\\b${leaf}\\b`).test(error.message ?? ''),
  );
  assert.ok(inMessage || inPath, `no ${field} in ${body}`);
}

/** Refused over REST (400) and GraphQL, naming the field, writing nothing. */
async function refusedCreate(input: object, field: string) {
  await app.eventBus.drain();
  const before = await snapshot();
  emitted.length = 0;

  const rest = await createRest(input);
  assert.equal(rest.statusCode, 400, rest.body);
  // REST's own validation answers first for what the schema states, with the
  // field in subErrors; the domain's rules answer in the message.
  assertRestNames(rest.body, field);

  assertRefusedGql(await createGql(input), field);

  await app.eventBus.drain();
  assert.equal(await snapshot(), before, 'a row was written');
  assert.deepEqual(emitted, [], 'an event was emitted');
}

async function refusedUpdate(input: object, field: string) {
  await app.eventBus.drain();
  const before = await snapshot();
  emitted.length = 0;

  const rest = await updateRest(input);
  assert.equal(rest.statusCode, 400, rest.body);
  assertRestNames(rest.body, field);
  assertRefusedGql(await updateGql(input), field);

  await app.eventBus.drain();
  assert.equal(await snapshot(), before, 'a row was changed');
  assert.deepEqual(emitted, [], 'an event was emitted');
}

describe('Story 5.1: monitors are validated on REST and GraphQL', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    serviceId = await createService(app, cookie);
    monitorId = await createMonitor(app, cookie, serviceId);

    for (const creator of Object.values(monitorEvents)) {
      if (typeof creator === 'function' && 'type' in creator) {
        app.eventBus.on(creator.type as string, (e: { type: string }) =>
          emitted.push(e.type),
        );
      }
    }
  });

  after(async () => {
    await app.eventBus.drain();
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  describe('invalid configuration', () => {
    it('refuses an http target that is not an http(s) URL', async () => {
      for (const target of [
        'ftp://203.0.113.10/',
        'example.com/health',
        'not a url',
        'https://user:pw@203.0.113.10/',
      ]) {
        await refusedCreate({ ...GOOD, target }, 'target');
      }
    });

    it('refuses a keyword monitor with no keyword, an empty one, or a blank one', async () => {
      const base = { ...GOOD, type: 'keyword' };
      await refusedCreate(base, 'config/keyword');
      await refusedCreate({ ...base, config: {} }, 'config/keyword');
      await refusedCreate(
        { ...base, config: { keyword: '' } },
        'config/keyword',
      );
      await refusedCreate(
        { ...base, config: { keyword: '   ' } },
        'config/keyword',
      );
    });

    it('refuses a tcp target with no port or a port outside 1-65535', async () => {
      for (const target of [
        '203.0.113.10',
        '203.0.113.10:0',
        '203.0.113.10:65536',
        '203.0.113.10:abc',
        '::1:80',
      ]) {
        await refusedCreate({ ...GOOD, type: 'tcp', target }, 'target');
      }
    });

    it('refuses an ssl_expiry monitor without a positive whole warnDays', async () => {
      const base = { ...GOOD, type: 'ssl_expiry', target: '203.0.113.10' };
      await refusedCreate(base, 'config/warnDays');
      for (const warnDays of [0, -1, 366]) {
        await refusedCreate(
          { ...base, config: { warnDays } },
          'config/warnDays',
        );
      }
      // A fraction is refused by GraphQL's own Int type and by REST's schema.
      const rest = await createRest({ ...base, config: { warnDays: 1.5 } });
      assert.equal(rest.statusCode, 400, rest.body);
    });

    it('refuses a config key that belongs to another type', async () => {
      await refusedCreate(
        { ...GOOD, config: { warnDays: 7 } },
        'config/warnDays',
      );
      await refusedCreate(
        { ...GOOD, config: { keyword: 'x' } },
        'config/keyword',
      );
    });

    it('refuses a timeout that is not below the interval', async () => {
      await refusedCreate(
        { ...GOOD, intervalSeconds: 30, timeoutSeconds: 30 },
        'timeoutSeconds',
      );
      // A patch that sends both: the new timeout (31) exceeds the new interval (30).
      await refusedUpdate(
        { intervalSeconds: 30, timeoutSeconds: 31 },
        'timeoutSeconds',
      );
    });

    it('refuses a failure threshold below 1 or above 20', async () => {
      for (const failureThreshold of [0, -1, 21]) {
        await refusedCreate({ ...GOOD, failureThreshold }, 'failureThreshold');
        await refusedUpdate({ failureThreshold }, 'failureThreshold');
      }
    });

    it('refuses an interval and a timeout outside their bounds', async () => {
      for (const intervalSeconds of [29, 86_401]) {
        await refusedCreate({ ...GOOD, intervalSeconds }, 'intervalSeconds');
      }
      await refusedCreate({ ...GOOD, timeoutSeconds: 0 }, 'timeoutSeconds');
      await refusedCreate({ ...GOOD, timeoutSeconds: 61 }, 'timeoutSeconds');
    });

    it('refuses a name or target of the wrong length and an unknown type', async () => {
      await refusedCreate({ ...GOOD, name: '' }, 'name');
      await refusedCreate({ ...GOOD, name: 'n'.repeat(121) }, 'name');
      await refusedCreate(
        { ...GOOD, target: `https://203.0.113.10/${'a'.repeat(2048)}` },
        'target',
      );
      await refusedCreate({ ...GOOD, type: 'icmp' }, 'type');
      await refusedUpdate({ name: '' }, 'name');
    });

    it('refuses a changed target that no longer fits the type', async () => {
      await refusedUpdate({ target: 'ftp://203.0.113.10/' }, 'target');
    });
  });

  describe('blocked targets (courtesy check)', () => {
    it('refuses localhost, private, link-local and mapped-loopback targets', async () => {
      const cases: Array<[string, string]> = [
        ['http', 'http://localhost/'],
        ['http', 'http://api.localhost:8080/'],
        ['tcp', '10.0.0.1:22'],
        ['http', 'http://[::ffff:7f00:1]/'],
        ['http', 'http://169.254.169.254/latest/meta-data/'],
        ['tcp', '[fd00::1]:22'],
        ['ssl_expiry', '192.168.1.1'],
        ['tcp', '127.1:80'],
        ['ssl_expiry', '2130706433'],
        ['tcp', 'localhost..:80'],
      ];
      for (const [type, target] of cases) {
        const config = type === 'ssl_expiry' ? { config: { warnDays: 7 } } : {};
        await refusedCreate({ ...GOOD, type, target, ...config }, 'target');
      }
    });

    it('refuses a blocked target on update', async () => {
      await refusedUpdate({ target: 'http://10.1.2.3/' }, 'target');
    });
  });

  describe('GraphQL input the schema cannot state', () => {
    it('refuses a malformed id and serviceId, naming the field, below 500', async () => {
      const update = await gql(
        app,
        `mutation ($id: ID!, $input: UpdateMonitorPayload!) { updateMonitor(id: $id, input: $input) }`,
        { cookie, variables: { id: 'not-a-uuid', input: { name: 'x' } } },
      );
      assertRefusedGql(update, 'id');
      assertRefusedGql(
        await createGql({ ...GOOD, serviceId: 'not-a-uuid' }),
        'serviceId',
      );
    });

    it('refuses an explicit null where a value is optional but never null', async () => {
      for (const field of ['intervalSeconds', 'enabled', 'config']) {
        await refusedGqlOnly(createGql({ ...GOOD, [field]: null }), field);
        await refusedGqlOnly(updateGql({ [field]: null }), field);
      }
      await refusedGqlOnly(
        createGql({ ...GOOD, type: 'keyword', config: { keyword: null } }),
        'config/keyword',
      );
      await refusedGqlOnly(
        updateGql({ config: { keyword: null } }),
        'config/keyword',
      );
    });

    it('names the target and another problem together', async () => {
      const result = await updateGql({
        target: 'ftp://203.0.113.10/',
        intervalSeconds: 30,
        timeoutSeconds: 31,
      });
      assertRefusedGql(result, 'target');
      assertRefusedGql(result, 'timeoutSeconds');
    });
  });

  describe('the allowed list reaches the handlers', () => {
    const original = config.monitor.allowedCidrs;
    afterEach(() => {
      config.monitor.allowedCidrs = original;
    });

    it('accepts a blocked literal and localhost inside the list, refuses one outside', async () => {
      config.monitor.allowedCidrs = parseAllowedCidrs(
        '10.20.0.0/16, 127.0.0.0/8, ::1/128',
      );
      const inside = await createRest({
        ...GOOD,
        type: 'tcp',
        target: '10.20.3.4:22',
      });
      assert.equal(inside.statusCode, 201, inside.body);
      const local = await createGql({ ...GOOD, target: 'http://localhost/' });
      assert.equal(local.body.errors, undefined, JSON.stringify(local.body));
      const moved = await updateRest({ target: 'http://10.20.9.9/' });
      assert.equal(moved.statusCode, 200, moved.body);

      await refusedCreate(
        { ...GOOD, type: 'tcp', target: '10.21.0.1:22' },
        'target',
      );
      await refusedUpdate({ target: 'http://10.21.0.1/' }, 'target');
    });

    it('refuses localhost when only part of it is allowed', async () => {
      config.monitor.allowedCidrs = parseAllowedCidrs('127.0.0.0/8');
      await refusedCreate({ ...GOOD, target: 'http://localhost/' }, 'target');
    });

    it('does not re-check a target that is sent back unchanged', async () => {
      config.monitor.allowedCidrs = parseAllowedCidrs('10.30.0.0/16');
      const created = await createRest({
        ...GOOD,
        target: 'http://10.30.0.5/',
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = JSON.parse(created.body).id as string;

      config.monitor.allowedCidrs = [];
      const resend = await app.inject({
        method: 'PATCH',
        url: `/api/v1/monitors/${id}`,
        headers: { cookie, origin: TEST_ORIGIN },
        payload: { target: 'http://10.30.0.5/', enabled: false },
      });
      assert.equal(resend.statusCode, 200, resend.body);
      const changed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/monitors/${id}`,
        headers: { cookie, origin: TEST_ORIGIN },
        payload: { target: 'http://10.30.0.6/' },
      });
      assert.equal(changed.statusCode, 400, changed.body);
    });
  });
});
