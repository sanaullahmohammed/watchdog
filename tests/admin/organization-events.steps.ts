import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { OrganizationEvent } from '@/server/realtime/hub-iterator';
import {
  createService,
  declareIncident,
  openMonitorDraft,
} from '@/shared/testing/fixtures';
import {
  openSubscription,
  type SubscriptionClient,
} from '@/shared/testing/graphql';
import { subscribeForOrg } from '@/shared/testing/notifications';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';
import type { ICustomWorld } from '../support/custom-world';

/**
 * The operator's side goes over a real WebSocket to the listening app, the
 * way the dashboard subscribes: the session cookie and the dashboard's
 * `Origin` on the upgrade, `graphql-transport-ws` on the socket. Fixtures go
 * through the admin API with the same session.
 */

const SUBSCRIPTION = `subscription {
  organizationEvents { eventName aggregateType aggregateId occurredAt }
}`;
const SENTINEL_AGGREGATE_TYPE = 'test.sentinel';
const WAIT_MS = 10_000;

type Subscribed = { client: SubscriptionClient; id: string };

const subscribed = (world: ICustomWorld): Subscribed =>
  world.context.subscription;

/** The next event the subscription is sent, sentinels included. */
async function nextEvent(
  { client, id }: Subscribed,
  timeoutMs = WAIT_MS,
): Promise<OrganizationEvent> {
  const message = await client.next(timeoutMs);
  assert.equal(message.type, 'next', JSON.stringify(message));
  assert.equal(message.id, id);
  const payload = message.payload as {
    data?: { organizationEvents?: OrganizationEvent };
  };
  const event = payload.data?.organizationEvents;
  assert.ok(event, JSON.stringify(payload));
  return event;
}

/** Reads until `eventName` arrives for `aggregateId`, past any other event. */
async function awaitEvent(
  world: ICustomWorld,
  eventName: string,
  aggregateId: string,
) {
  const seen: OrganizationEvent[] = [];
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const left = deadline - Date.now();
    assert.ok(
      left > 0,
      `no ${eventName} for ${aggregateId}; was sent ${JSON.stringify(seen)}`,
    );
    const event = await nextEvent(subscribed(world), left);
    if (event.eventName === eventName && event.aggregateId === aggregateId) {
      assert.ok(!Number.isNaN(Date.parse(event.occurredAt)), event.occurredAt);
      return event;
    }
    seen.push(event);
  }
}

After(async function (this: ICustomWorld) {
  await this.context.subscription?.client.close();
});

Given(
  'an operator signed in to an organization of their own',
  async function (this: ICustomWorld) {
    const slug = `e2e-ev-${randomBytes(4).toString('hex')}`;
    const { cookie, userId, orgId } = await signUpWithOrg(this.server, slug);
    Object.assign(this.context, { slug, cookie, userId, orgId, services: {} });
  },
);

Given(
  'the organization has a service {string}',
  async function (this: ICustomWorld, name: string) {
    const slug = `${this.context.slug}-${name.toLowerCase().replaceAll(/\W+/g, '-')}`;
    this.context.services[name] = await createService(
      this.server,
      this.context.cookie,
      { name, slug },
    );
  },
);

Given(
  "the operator is subscribed to the organization's events",
  async function (this: ICustomWorld) {
    const client = await openSubscription(this.baseUrl, {
      cookie: this.context.cookie,
      origin: TEST_ORIGIN,
    });
    const id = client.subscribe(SUBSCRIPTION);
    this.context.subscription = { client, id } satisfies Subscribed;

    // Live once a sentinel arrives. The subscribe resolves the session before
    // it joins the hub, so one sent too early is missed: send until one is.
    const probe = subscribeForOrg(this.server.realtimeHub, this.context.orgId);
    try {
      for (let attempt = 1; ; attempt += 1) {
        await probe.settle(this.server);
        const event = await nextEvent(subscribed(this), 1_000).catch(
          () => undefined,
        );
        if (event) {
          assert.equal(event.aggregateType, SENTINEL_AGGREGATE_TYPE);
          return;
        }
        assert.ok(attempt < 10, 'the subscription never went live');
      }
    } finally {
      probe.close();
    }
  },
);

When(
  'the operator declares the incident {string} on {string}',
  async function (this: ICustomWorld, title: string, service: string) {
    this.context.incidentId = await declareIncident(
      this.server,
      this.context.cookie,
      {
        title,
        affectedServices: [
          { serviceId: this.context.services[service], impact: 'minor' },
        ],
      },
    );
  },
);

When(
  'a monitor opens a draft incident on {string}',
  async function (this: ICustomWorld, service: string) {
    this.context.incidentId = await openMonitorDraft(
      this.server,
      this.context.cookie,
      this.context.orgId,
      this.context.services[service],
    );
  },
);

When(
  'the operator sets the status of {string} to {string}',
  async function (this: ICustomWorld, service: string, status: string) {
    const response = await this.server.inject({
      method: 'PUT',
      url: `/api/v1/services/${this.context.services[service]}/status-override`,
      headers: { cookie: this.context.cookie, origin: TEST_ORIGIN },
      payload: { status },
    });
    assert.ok(response.statusCode < 300, response.body);
  },
);

Then(
  'the subscription is sent {string} for that incident',
  async function (this: ICustomWorld, eventName: string) {
    const event = await awaitEvent(this, eventName, this.context.incidentId);
    assert.equal(event.aggregateType, 'incident');
  },
);

Then(
  'the subscription is sent {string} for the service {string}',
  async function (this: ICustomWorld, eventName: string, service: string) {
    const event = await awaitEvent(
      this,
      eventName,
      this.context.services[service],
    );
    assert.equal(event.aggregateType, 'service');
  },
);
