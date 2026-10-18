import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import {
  monitorCheckFailedEvent,
  monitorCreatedEvent,
  monitorThresholdBreachedEvent,
} from '@/shared/events/monitor.events';
import { serviceGroupCreatedEvent } from '@/shared/events/service.events';
import { registerNotifyBridge } from '@/shared/realtime/notify-bridge';
import {
  createMonitor,
  createService,
  createServiceGroup,
} from '@/shared/testing/fixtures';
import { listenForOrg } from '@/shared/testing/notifications';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 4.3: a committed domain event reaches `watchdog_events`.
 *
 * Every listener here is filtered by the organization the test made, because
 * every concurrently running integration file bridges onto the same channel.
 */

const tag = `ntf-${randomBytes(4).toString('hex')}`;

const KEYS = [
  'aggregateId',
  'aggregateType',
  'eventName',
  'occurredAt',
  'orgId',
  'version',
];

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
let serviceAId = '';
let serviceBId = '';

function postIncident(
  target: FastifyInstance,
  cookie: string,
  payload: Record<string, unknown>,
) {
  return target.inject({
    method: 'POST',
    url: '/api/v1/incidents',
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  });
}

describe('Story 4.3: bridge domain events to NOTIFY', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, `${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(app, `${tag}-b`));
    serviceAId = await createService(app, cookieA);
    serviceBId = await createService(app, cookieB);
    // Whatever the setup announced is heard by nobody: every listener below
    // starts after it.
    await app.eventBus.drain();
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('announces a committed incident as the incident, and only that', async () => {
    const listener = await listenForOrg(orgAId);
    try {
      const start = Date.now();
      const response = await postIncident(app, cookieA, {
        title: 'Checkout is failing',
        impact: 'major',
      });
      assert.equal(response.statusCode, 201, response.body);
      const { id } = JSON.parse(response.body) as { id: string };

      await listener.settle(app);

      assert.equal(listener.received.length, 1, 'one notification');
      const [event] = listener.received;
      assert.deepEqual(Object.keys(event).sort(), KEYS);
      assert.deepEqual(
        { ...event, occurredAt: undefined },
        {
          eventName: 'incident.created',
          orgId: orgAId,
          aggregateType: 'incident',
          aggregateId: id,
          occurredAt: undefined,
          version: 1,
        },
      );
      // The emit time, which falls inside the request.
      const occurredAt = Date.parse(event.occurredAt);
      // Two seconds' slack each way: on Docker Desktop under WSL2 the clock
      // steps back by up to 1.4 s (AGENTS.md).
      const slack = 2_000;
      assert.ok(
        occurredAt >= start - slack && occurredAt <= Date.now() + slack,
        `${event.occurredAt} is not within the request`,
      );
    } finally {
      await listener.close();
    }
  });

  it('announces a monitor event as the monitor', async () => {
    const monitorId = await createMonitor(app, cookieA, serviceAId);
    await app.eventBus.drain();

    const listener = await listenForOrg(orgAId);
    try {
      app.eventBus.emit(
        monitorThresholdBreachedEvent({
          orgId: orgAId,
          monitorId,
          serviceId: serviceAId,
          monitorName: 'Checkout health',
          failureEpisode: 1,
        }),
      );
      await listener.settle(app);

      const breaches = listener.received.filter(
        (event) => event.eventName === 'monitor.threshold_breached',
      );
      assert.equal(breaches.length, 1);
      assert.deepEqual(Object.keys(breaches[0]).sort(), KEYS);
      assert.equal(breaches[0].aggregateType, 'monitor');
      assert.equal(breaches[0].aggregateId, monitorId);
    } finally {
      await listener.close();
    }
  });

  it('does not announce what DOMAIN does not bridge', async () => {
    const listener = await listenForOrg(orgAId);
    try {
      const monitor = {
        orgId: orgAId,
        monitorId: randomUUID(),
        serviceId: serviceAId,
        monitorName: 'Not bridged',
      };
      app.eventBus.emit(monitorCreatedEvent(monitor));
      app.eventBus.emit(
        monitorCheckFailedEvent({
          ...monitor,
          checkedAt: new Date().toISOString(),
          errorCode: 'timeout',
        }),
      );
      await listener.settle(app);

      assert.deepEqual(listener.received, []);
    } finally {
      await listener.close();
    }
  });

  it('does not announce a change that rolled back', async () => {
    const listener = await listenForOrg(orgAId);
    try {
      const response = await postIncident(app, cookieA, {
        title: 'Cross-tenant attempt',
        impact: 'critical',
        affectedServices: [{ serviceId: serviceBId, impact: 'critical' }],
      });
      assert.equal(response.statusCode, 400, response.body);

      await listener.settle(app);
      assert.deepEqual(listener.received, []);
    } finally {
      await listener.close();
    }
  });

  it('keeps each organization to its own notifications', async () => {
    const listenerA = await listenForOrg(orgAId);
    const listenerB = await listenForOrg(orgBId);
    try {
      const groupAId = await createServiceGroup(app, cookieA);
      const groupBId = await createServiceGroup(app, cookieB);
      await listenerA.settle(app);
      await listenerB.settle(app);

      assert.deepEqual(
        listenerA.received.map((event) => [event.orgId, event.aggregateId]),
        [[orgAId, groupAId]],
      );
      assert.deepEqual(
        listenerB.received.map((event) => [event.orgId, event.aggregateId]),
        [[orgBId, groupBId]],
      );
    } finally {
      await listenerA.close();
      await listenerB.close();
    }
  });

  it('still answers 201, and still announces, when another pg_notify is refused', async () => {
    // Built while `app` is open: Better Auth's pool ends at the last close.
    const refusing = await buildApp({ logger: false });
    await refusing.ready();
    let refusals = 0;
    const refusingSql = (() => {
      refusals += 1;
      return Promise.reject(new Error('pg_notify refused'));
    }) as unknown as Sql;
    registerNotifyBridge(refusing.eventBus, refusingSql);

    const listener = await listenForOrg(orgAId);
    try {
      const response = await postIncident(refusing, cookieA, {
        title: 'Announced despite a refusal',
        impact: 'minor',
      });
      assert.equal(response.statusCode, 201, response.body);
      const { id } = JSON.parse(response.body) as { id: string };

      await listener.settle(refusing);
      assert.equal(refusals, 1, 'the refusing bridge was reached');
      assert.deepEqual(
        listener.received.map((event) => [event.eventName, event.aggregateId]),
        [['incident.created', id]],
      );
    } finally {
      await listener.close();
      await refusing.close();
    }
  });

  // Last in the file, on its own app, as in event-bus.integration.test.ts.
  it('sends what was emitted before the app closed', async () => {
    const closing = await buildApp({ logger: false });
    await closing.ready();

    const listener = await listenForOrg(orgAId);
    try {
      const id = randomUUID();
      closing.eventBus.emit(
        serviceGroupCreatedEvent({ id, orgId: orgAId, slug: `${tag}-closing` }),
      );
      await closing.close();

      // Shows that a notification emitted before the close still arrives. It
      // cannot show that the close drained: the bridge's query starts at emit
      // and the global pool stays open, so it passes without the drain too.
      // The drain itself is proven in src/shared/cqrs/event-bus.integration.test.ts.
      // Settled without the app, since its bus is already closed.
      await listener.settle();
      assert.deepEqual(
        listener.received.map((event) => [event.eventName, event.aggregateId]),
        [['service_group.created', id]],
      );
    } finally {
      await listener.close();
    }
  });
});
