import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import * as events from '@/shared/events/monitor.events';
import {
  createMonitor,
  createService,
  setMonitorCheckState,
} from '@/shared/testing/fixtures';
import { gql } from '@/shared/testing/graphql';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 5.1: create and update a monitor.
 *
 * Targets are TEST-NET-3 literals (203.0.113.0/24), which the courtesy check
 * accepts without a DNS lookup. Refusals are in
 * monitor-input-validation.integration.test.ts.
 */

const tag = `mon-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
let otherCookie = '';
let otherUserId = '';
let otherOrgId = '';
let serviceId = '';

type Emitted = { type: string; payload: Record<string, unknown> };
const emitted: Emitted[] = [];

const api = (
  method: 'POST' | 'PATCH',
  url: string,
  payload: object,
  as = cookie,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: as, origin: TEST_ORIGIN },
    payload,
  });

type MonitorRow = {
  id: string;
  org_id: string;
  service_id: string;
  type: string;
  name: string;
  target: string;
  interval_seconds: number;
  timeout_seconds: number;
  enabled: boolean;
  failure_threshold: number;
  config: Record<string, unknown>;
  consecutive_failures: number;
  failure_episode: number;
  last_checked_at: Date | null;
  updated_at: Date;
};

async function row(id: string, as = orgId): Promise<MonitorRow | undefined> {
  const rows = await withTenantTransaction(
    as,
    ({ sql: tx }) => tx<MonitorRow[]>`select * from monitors where id = ${id}`,
  );
  return rows[0];
}

async function eventsFor(id: string): Promise<Emitted[]> {
  await app.eventBus.drain();
  return emitted.filter((e) => e.payload.monitorId === id);
}

const patch = (id: string, body: object) =>
  api('PATCH', `/monitors/${id}`, body);

/** A fresh enabled monitor with the given counters and threshold. */
async function monitorWith(
  failures: number,
  failureThreshold = 3,
  overrides: object = {},
) {
  const id = await createMonitor(app, cookie, serviceId, {
    failureThreshold,
    ...overrides,
  });
  await setMonitorCheckState(orgId, id, { consecutiveFailures: failures });
  emitted.length = 0;
  return id;
}

describe('Story 5.1: create and update a monitor', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    ({
      cookie: otherCookie,
      userId: otherUserId,
      orgId: otherOrgId,
    } = await signUpWithOrg(app, `${tag}-b`));
    serviceId = await createService(app, cookie);

    const registered: string[] = [];
    for (const creator of Object.values(events)) {
      if (typeof creator === 'function' && 'type' in creator) {
        registered.push(creator.type as string);
        app.eventBus.on(creator.type as string, (e: Emitted) =>
          emitted.push({ type: e.type, payload: e.payload }),
        );
      }
    }
    assert.deepEqual(
      registered.sort(),
      ['monitor/created', 'monitor/state_changed', 'monitor/updated'].sort(),
    );
  });

  after(async () => {
    await app.eventBus.drain();
    for (const id of [orgId, otherOrgId]) {
      await sql`delete from "organization" where "id" = ${id}`;
    }
    for (const id of [userId, otherUserId]) {
      await sql`delete from "user" where "id" = ${id}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('watchdog_app cannot delete a monitor (v1 has no monitor delete)', async () => {
    const [privilege] = await sql<{ allowed: boolean }[]>`
      select has_table_privilege('watchdog_app', 'monitors', 'DELETE') as allowed
    `;
    assert.equal(privilege?.allowed, false);
  });

  describe('create', () => {
    const cases: Array<[string, object]> = [
      ['http', { type: 'http', target: 'https://203.0.113.10/health' }],
      ['tcp', { type: 'tcp', target: '203.0.113.11:5432' }],
      [
        'keyword',
        {
          type: 'keyword',
          target: 'http://203.0.113.12/',
          config: { keyword: 'all systems go' },
        },
      ],
      [
        'ssl_expiry',
        {
          type: 'ssl_expiry',
          target: '203.0.113.13',
          config: { warnDays: 14 },
        },
      ],
    ];

    for (const [type, body] of cases) {
      it(`creates a ${type} monitor with defaults and announces it`, async () => {
        emitted.length = 0;
        const response = await api('POST', '/monitors', {
          serviceId,
          name: `${tag}-${type}`,
          ...body,
        });
        assert.equal(response.statusCode, 201, response.body);
        const { id } = JSON.parse(response.body);

        const saved = await row(id);
        assert.ok(saved);
        assert.equal(saved.org_id, orgId);
        assert.equal(saved.service_id, serviceId);
        assert.equal(saved.type, type);
        assert.equal(saved.consecutive_failures, 0);
        assert.equal(saved.failure_episode, 0);
        assert.equal(saved.last_checked_at, null);
        assert.equal(saved.enabled, true);
        assert.equal(saved.interval_seconds, 60);
        assert.equal(saved.timeout_seconds, 10);
        assert.equal(saved.failure_threshold, 3);

        const seen = await eventsFor(id);
        assert.deepEqual(
          seen.map((e) => e.type),
          ['monitor/created'],
        );
        assert.deepEqual(seen[0]?.payload, {
          orgId,
          monitorId: id,
          serviceId,
          monitorName: `${tag}-${type}`,
        });

        // A second organization cannot read it.
        assert.equal(await row(id, otherOrgId), undefined);
      });
    }

    it('stores non-default values as sent', async () => {
      const id = await createMonitor(app, cookie, serviceId, {
        enabled: false,
        failureThreshold: 7,
        intervalSeconds: 300,
        timeoutSeconds: 25,
      });
      const saved = await row(id);
      assert.equal(saved?.enabled, false);
      assert.equal(saved?.failure_threshold, 7);
      assert.equal(saved?.interval_seconds, 300);
      assert.equal(saved?.timeout_seconds, 25);
      assert.equal(saved?.last_checked_at, null);
    });

    it('creates over GraphQL too, with a typed config', async () => {
      const result = await gql(
        app,
        `mutation ($input: CreateMonitorPayload!) { createMonitor(input: $input) }`,
        {
          cookie,
          variables: {
            input: {
              serviceId,
              type: 'ssl_expiry',
              name: `${tag}-gql`,
              target: '203.0.113.14:8443',
              config: { warnDays: 30 },
            },
          },
        },
      );
      assert.equal(result.body.errors, undefined, JSON.stringify(result.body));
      const saved = await row(String(result.body.data?.createMonitor));
      assert.deepEqual(saved?.config, { warnDays: 30 });
    });

    it('accepts a monitor on an archived service', async () => {
      const archived = await createService(app, cookie);
      const archive = await app.inject({
        method: 'POST',
        url: `/api/v1/services/${archived}/archive`,
        headers: { cookie, origin: TEST_ORIGIN },
      });
      assert.equal(archive.statusCode, 200, archive.body);
      const id = await createMonitor(app, cookie, archived);
      assert.ok(await row(id));
    });

    it("refuses an unknown service and another organization's, naming the service", async () => {
      const foreign = await createService(app, otherCookie);
      for (const unknown of [randomUUID(), foreign]) {
        emitted.length = 0;
        const response = await api('POST', '/monitors', {
          serviceId: unknown,
          type: 'http',
          name: tag,
          target: 'https://203.0.113.10/',
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.match(
          JSON.parse(response.body).message,
          /^Invalid input\. serviceId: /,
        );
        await app.eventBus.drain();
        assert.deepEqual(emitted, []);
      }
    });
  });

  describe('update', () => {
    it('persists every editable field and emits monitor.updated', async () => {
      const id = await monitorWith(0);
      const response = await patch(id, {
        name: 'Renamed',
        target: 'https://203.0.113.20/ready',
        intervalSeconds: 120,
        timeoutSeconds: 20,
        failureThreshold: 5,
        config: {},
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(JSON.parse(response.body), { id });

      const saved = await row(id);
      assert.equal(saved?.name, 'Renamed');
      assert.equal(saved?.target, 'https://203.0.113.20/ready');
      assert.equal(saved?.interval_seconds, 120);
      assert.equal(saved?.timeout_seconds, 20);
      assert.equal(saved?.failure_threshold, 5);
      assert.deepEqual(
        (await eventsFor(id)).map((e) => e.type),
        ['monitor/updated'],
      );
    });

    it('leaves absent keys alone and replaces config whole', async () => {
      const id = await createMonitor(app, cookie, serviceId, {
        type: 'keyword',
        target: 'http://203.0.113.21/',
        config: { keyword: 'first' },
        name: 'keep me',
      });
      emitted.length = 0;
      const ok = await patch(id, { config: { keyword: 'second' } });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(
        (await eventsFor(id)).map((e) => e.type),
        ['monitor/updated'],
      );
      const saved = await row(id);
      assert.deepEqual(saved?.config, { keyword: 'second' });
      assert.equal(saved?.name, 'keep me');

      // Whole replacement: a config without the keyword leaves a keyword
      // monitor invalid, so it is refused and the stored one stays.
      const refused = await patch(id, { config: {} });
      assert.equal(refused.statusCode, 400, refused.body);
      assert.deepEqual((await row(id))?.config, { keyword: 'second' });
    });

    it('a patch that changes no stored value returns the id and emits nothing', async () => {
      const id = await monitorWith(1);
      const before = await row(id);
      for (const body of [
        {},
        { name: before?.name, intervalSeconds: before?.interval_seconds },
        { config: {} },
        { enabled: true },
        { target: before?.target },
      ]) {
        const response = await patch(id, body);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(JSON.parse(response.body), { id });
      }
      assert.deepEqual(await row(id), before);
      assert.deepEqual(await eventsFor(id), []);
    });

    it('enabled: true on an enabled degraded monitor changes and announces nothing', async () => {
      const id = await monitorWith(2, 3);
      const before = await row(id);
      assert.equal((await patch(id, { enabled: true })).statusCode, 200);
      assert.deepEqual(await row(id), before);
      assert.deepEqual(await eventsFor(id), []);
    });

    it('an enabled-only change announces monitor.updated, and updated_at moves only on a change', async () => {
      const id = await monitorWith(0);
      const created = await row(id);
      assert.equal((await patch(id, {})).statusCode, 200);
      const untouched = await row(id);
      assert.deepEqual(untouched?.updated_at, created?.updated_at);

      emitted.length = 0;
      assert.equal((await patch(id, { enabled: false })).statusCode, 200);
      // Disabling a checked monitor also moves its state, healthy -> null.
      assert.deepEqual(
        (await eventsFor(id)).map((e) => e.type),
        ['monitor/updated', 'monitor/state_changed'],
      );
      const changed = await row(id);
      assert.ok(
        (changed?.updated_at as Date) > (untouched?.updated_at as Date),
        'updated_at did not move',
      );
    });

    it('refuses a one-field timeout patch against the stored interval', async () => {
      const id = await monitorWith(0, 3, { intervalSeconds: 30 });
      const response = await patch(id, { timeoutSeconds: 40 });
      assert.equal(response.statusCode, 400, response.body);
      assert.match(
        JSON.parse(response.body).message,
        /^Invalid input\. timeoutSeconds: /,
      );
      assert.equal((await row(id))?.timeout_seconds, 10);
      assert.deepEqual(await eventsFor(id), []);
    });

    it('refuses a changed target that is blocked, leaving the stored one', async () => {
      const id = await monitorWith(0);
      const response = await patch(id, { target: 'http://10.9.9.9/' });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await row(id))?.target, 'https://203.0.113.10/health');
    });

    it("answers 404 for an unknown monitor and for another organization's, changing nothing", async () => {
      const id = await monitorWith(0);
      const before = await row(id);

      assert.equal((await patch(randomUUID(), { name: 'x' })).statusCode, 404);
      const foreign = await api(
        'PATCH',
        `/monitors/${id}`,
        { name: 'hijacked' },
        otherCookie,
      );
      assert.equal(foreign.statusCode, 404, foreign.body);
      assert.deepEqual(await row(id), before);
      assert.deepEqual(await eventsFor(id), []);

      // A changed target on a monitor that is not theirs is also a 404.
      const foreignTarget = await api(
        'PATCH',
        `/monitors/${id}`,
        { target: 'https://203.0.113.99/' },
        otherCookie,
      );
      assert.equal(foreignTarget.statusCode, 404, foreignTarget.body);
    });

    it('updates over GraphQL', async () => {
      const id = await monitorWith(0);
      const result = await gql(
        app,
        `mutation ($id: ID!, $input: UpdateMonitorPayload!) { updateMonitor(id: $id, input: $input) }`,
        { cookie, variables: { id, input: { intervalSeconds: 90 } } },
      );
      assert.equal(result.body.data?.updateMonitor, id);
      assert.equal((await row(id))?.interval_seconds, 90);
    });
  });

  describe('derived state', () => {
    const stateEvents = async (id: string) =>
      (await eventsFor(id)).filter((e) => e.type === 'monitor/state_changed');

    it('disabling a degraded monitor emits degraded -> null', async () => {
      const id = await monitorWith(1, 3);
      const response = await patch(id, { enabled: false });
      assert.equal(response.statusCode, 200, response.body);
      const seen = await stateEvents(id);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.payload.from, 'degraded');
      assert.equal(seen[0]?.payload.to, null);
      assert.equal(seen[0]?.payload.failureEpisode, 0);
      assert.equal((await row(id))?.failure_episode, 0);
    });

    it('disabling a failing monitor emits failing -> null with the full payload', async () => {
      const id = await monitorWith(3, 3);
      await setMonitorCheckState(orgId, id, {
        consecutiveFailures: 3,
        failureEpisode: 1,
      });
      emitted.length = 0;
      assert.equal((await patch(id, { enabled: false })).statusCode, 200);
      const seen = await stateEvents(id);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0]?.payload, {
        orgId,
        monitorId: id,
        serviceId,
        monitorName: (await row(id))?.name,
        from: 'failing',
        to: null,
        failureEpisode: 1,
      });
    });

    it('raising the threshold out of failing emits failing -> degraded, episode unchanged', async () => {
      const id = await monitorWith(3, 3);
      await setMonitorCheckState(orgId, id, {
        consecutiveFailures: 3,
        failureEpisode: 1,
      });
      emitted.length = 0;
      assert.equal((await patch(id, { failureThreshold: 5 })).statusCode, 200);
      const seen = await stateEvents(id);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.payload.from, 'failing');
      assert.equal(seen[0]?.payload.to, 'degraded');
      assert.equal(seen[0]?.payload.failureEpisode, 1);
      assert.equal((await row(id))?.failure_episode, 1);
    });

    it('lowering the threshold into failing emits degraded -> failing and opens an episode', async () => {
      const id = await monitorWith(2, 3);
      assert.equal((await patch(id, { failureThreshold: 2 })).statusCode, 200);
      const seen = await stateEvents(id);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.payload.from, 'degraded');
      assert.equal(seen[0]?.payload.to, 'failing');
      assert.equal(seen[0]?.payload.failureEpisode, 1);
      assert.equal((await row(id))?.failure_episode, 1);

      // Staying failing opens nothing and announces no state change.
      emitted.length = 0;
      assert.equal((await patch(id, { failureThreshold: 1 })).statusCode, 200);
      assert.deepEqual(await stateEvents(id), []);
      assert.equal((await row(id))?.failure_episode, 1);
    });

    it('an edit that leaves the state where it was emits no state change', async () => {
      const id = await monitorWith(1, 3);
      assert.equal(
        (await patch(id, { failureThreshold: 5, name: 'same state' }))
          .statusCode,
        200,
      );
      assert.deepEqual(await stateEvents(id), []);
    });

    it('never emits monitor.threshold_breached', async () => {
      const id = await monitorWith(2, 3);
      await patch(id, { failureThreshold: 1 });
      const types = (await eventsFor(id)).map((e) => e.type);
      assert.ok(!types.includes('monitor/threshold_breached'), types.join());
    });

    it('re-enabling resets the counters, keeps the episode and emits no state change', async () => {
      const id = await monitorWith(4, 3);
      await setMonitorCheckState(orgId, id, {
        consecutiveFailures: 4,
        failureEpisode: 2,
      });
      assert.equal((await patch(id, { enabled: false })).statusCode, 200);
      emitted.length = 0;

      assert.equal((await patch(id, { enabled: true })).statusCode, 200);
      const saved = await row(id);
      assert.equal(saved?.consecutive_failures, 0);
      assert.equal(saved?.last_checked_at, null);
      assert.equal(saved?.failure_episode, 2);
      assert.deepEqual(await stateEvents(id), []);
    });

    it('re-enabling together with a threshold change ends at null', async () => {
      const id = await monitorWith(4, 3);
      assert.equal((await patch(id, { enabled: false })).statusCode, 200);
      emitted.length = 0;
      const episode = (await row(id))?.failure_episode;

      assert.equal(
        (await patch(id, { enabled: true, failureThreshold: 2 })).statusCode,
        200,
      );
      assert.deepEqual(await stateEvents(id), []);
      assert.equal((await row(id))?.failure_episode, episode);
    });

    it('two concurrent edits wait on the row lock and end coherent with at most one episode', async () => {
      const id = await monitorWith(0, 3);

      // Hold the row lock, start both PATCHes, then change the counters and
      // release. Only an edit that locks before it reads sees the new counters;
      // one that read first would compute its states from the stale row.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = withTenantTransaction(orgId, async ({ sql: tx }) => {
        await tx`select id from monitors where id = ${id} for update`;
        locked();
        await gate;
        await tx`
          update monitors set consecutive_failures = 2, last_checked_at = now()
          where id = ${id}
        `;
      });
      await hasLock;

      let settled = 0;
      const track = (request: ReturnType<typeof patch>) =>
        request.then((response) => {
          settled++;
          return response;
        });
      const pending = [
        track(patch(id, { enabled: false })),
        track(patch(id, { failureThreshold: 2 })),
      ];
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, 0, 'an edit finished while the row was locked');
      release();
      await holder;
      const [a, b] = await Promise.all(pending);
      assert.equal(a?.statusCode, 200, a?.body);
      assert.equal(b?.statusCode, 200, b?.body);

      const saved = await row(id);
      assert.equal(saved?.enabled, false);
      assert.equal(saved?.failure_threshold, 2);
      const episode = saved?.failure_episode ?? -1;
      assert.ok(episode === 0 || episode === 1, `episode ${episode}`);

      // The chain of announced states must be unbroken and end at null.
      const chain = (await stateEvents(id)).map((e) => [
        e.payload.from,
        e.payload.to,
      ]);
      assert.deepEqual(
        chain,
        episode === 1
          ? [
              ['degraded', 'failing'],
              ['failing', null],
            ]
          : [['degraded', null]],
      );
    });
  });
});
