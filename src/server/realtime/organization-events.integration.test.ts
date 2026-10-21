import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { auth } from '@/server/auth/auth';
import { buildApp } from '@/server/build-app';
import { SUBSCRIPTION_DEADLINE_MS } from '@/server/index';
import type { OrganizationEvent } from '@/server/realtime/hub-iterator';
import { MAX_SUBSCRIPTIONS_PER_SOCKET } from '@/server/realtime/organization-events.resolver';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { createService, openMonitorDraft } from '@/shared/testing/fixtures';
import {
  type GraphqlError,
  openSubscription,
  type RawUpgrade,
  rawUpgrade,
  type SubscriptionClient,
  type SubscriptionOptions,
  upgradeStatus,
  type WsMessage,
} from '@/shared/testing/graphql';
import { subscribeForOrg } from '@/shared/testing/notifications';
import {
  captureCookie,
  signUpWithOrg,
  TEST_ORIGIN,
  TEST_PASSWORD,
} from '@/shared/testing/tenant';

/**
 * Story 4.7: `Subscription.organizationEvents` over a real WebSocket.
 *
 * Every client is a real socket on a listening app, since the upgrade, its
 * headers and its refusal only behave as they do in production over a
 * connection. The 429 is tried on an app of its own, so the suite's bucket is
 * never spent, and the close test runs last because it closes the suite's app.
 */

const tag = `orgev-${randomBytes(4).toString('hex')}`;
const SUBSCRIPTION = `subscription {
  organizationEvents { eventName aggregateType aggregateId occurredAt }
}`;
const SENTINEL_AGGREGATE_TYPE = 'test.sentinel';
/** What the masked failure's original says, which no client may read. */
const INTERNAL = 'connect ECONNREFUSED 10.20.30.40:5432 (db.internal)';

let app: FastifyInstance;
let appClosed = false;
let baseUrl = '';
const logLines: string[] = [];

/** The operator, subscribed in their own organization A. */
const operator = { cookie: '', userId: '', orgId: '' };
/** Another organization, B, whose events A must never hear. */
const other = { cookie: '', userId: '', orgId: '' };
/** A role off the ladder: a valid session whose membership grants nothing. */
const offLadder = { cookie: '', userId: '', orgId: '' };
/** A valid session with no organization at all. */
const loner = { cookie: '', userId: '' };
/** A session that has expired. */
const expired = { cookie: '', userId: '', orgId: '' };

const open = (options: SubscriptionOptions = {}, to = baseUrl) =>
  openSubscription(to, { origin: TEST_ORIGIN, ...options });

/** The event a `next` message carries. */
function eventOf(message: WsMessage, id: string): OrganizationEvent {
  assert.equal(message.type, 'next', JSON.stringify(message));
  assert.equal(message.id, id);
  const payload = message.payload as {
    data?: { organizationEvents?: OrganizationEvent };
    errors?: unknown;
  };
  assert.equal(payload.errors, undefined, JSON.stringify(payload));
  const event = payload.data?.organizationEvents;
  assert.ok(event, JSON.stringify(payload));
  return event;
}

/**
 * Settles the organization's notifications through the app's hub: the bus is
 * drained, a sentinel is sent and heard. The sentinel reaches the socket too,
 * after everything sent before it, so the socket is then read up to it.
 */
async function settle(orgId: string) {
  const probe = subscribeForOrg(app.realtimeHub, orgId);
  try {
    await probe.settle(app);
  } finally {
    probe.close();
  }
}

/** Every event the socket is sent before the next sentinel. */
async function eventsUntilSentinel(
  client: SubscriptionClient,
  id: string,
): Promise<OrganizationEvent[]> {
  const events: OrganizationEvent[] = [];
  for (;;) {
    const event = eventOf(await client.next(), id);
    if (event.aggregateType === SENTINEL_AGGREGATE_TYPE) return events;
    events.push(event);
  }
}

/** A subscription that is live: its first sentinel has arrived. */
async function liveSubscription(cookie: string, orgId: string) {
  const client = await open({ cookie });
  const id = client.subscribe(SUBSCRIPTION);
  // The subscribe resolves the session before it joins the hub, so a sentinel
  // sent too early is missed: send them until one arrives.
  for (let attempt = 1; ; attempt += 1) {
    await settle(orgId);
    const message = await client.next(1_000).catch(() => undefined);
    if (message) {
      eventOf(message, id);
      return { client, id };
    }
    assert.ok(attempt < 10, 'the subscription never went live');
  }
}

/** A refusal: an `error` message with the code. */
async function assertError(
  client: SubscriptionClient,
  id: string,
  code: string,
): Promise<GraphqlError> {
  const message = await client.next();
  assert.equal(message.type, 'error', JSON.stringify(message));
  assert.equal(message.id, id);
  const errors = message.payload as GraphqlError[];
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].extensions?.code, code, JSON.stringify(errors));
  return errors[0];
}

/** The refusal: an `error` message with the code, then a close with 4401. */
async function assertRefused(
  client: SubscriptionClient,
  id: string,
  code = 'UNAUTHENTICATED',
) {
  const error = await assertError(client, id, code);
  const closed = await client.waitClosed();
  assert.equal(closed.code, 4401, JSON.stringify(closed));
  return error;
}

/** Every log line written so far, parsed. */
const logged = () =>
  logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

/** Waits until `holds()` is true, failing after `timeoutMs`. */
async function eventually(
  holds: () => boolean,
  what: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    assert.ok(Date.now() < deadline, `${what} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Counts the hub's admin subscriptions made while it is installed: each
 * `subscribeAdmin` call adds one, and its first unsubscribe removes it.
 */
function countAdminSubscriptions() {
  const hub = app.realtimeHub;
  const subscribeAdmin = hub.subscribeAdmin;
  const counter = { live: 0, calls: 0, restore: () => {} };
  hub.subscribeAdmin = (orgId, fn) => {
    const off = subscribeAdmin.call(hub, orgId, fn);
    counter.calls += 1;
    counter.live += 1;
    let done = false;
    return () => {
      if (!done) counter.live -= 1;
      done = true;
      off();
    };
  };
  counter.restore = () => {
    hub.subscribeAdmin = subscribeAdmin;
  };
  return counter;
}

/** Reads past `next` messages until `id`'s `complete` arrives. */
async function awaitComplete(client: SubscriptionClient, id: string) {
  for (;;) {
    const message = await client.next();
    if (message.type === 'next') continue;
    assert.equal(message.type, 'complete', JSON.stringify(message));
    assert.equal(message.id, id);
    return;
  }
}

/** Reads past other subscriptions' messages until `id` is sent an event. */
async function awaitEventFor(client: SubscriptionClient, id: string) {
  for (;;) {
    const message = await client.next();
    if (message.type === 'next' && message.id !== id) continue;
    return eventOf(message, id);
  }
}

/** Counts Better Auth session lookups while it is installed. */
function countSessionLookups() {
  const getSession = auth.api.getSession;
  const counter = { calls: 0, restore: () => {} };
  auth.api.getSession = ((...args: Parameters<typeof getSession>) => {
    counter.calls += 1;
    return getSession(...args);
  }) as typeof getSession;
  counter.restore = () => {
    auth.api.getSession = getSession;
  };
  return counter;
}

/** Signs a user up with no organization. */
async function signUpAlone(label: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: {
      email: `${label}@example.test`,
      password: TEST_PASSWORD,
      name: label,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return {
    cookie: captureCookie(response.headers as Record<string, unknown>),
    userId: JSON.parse(response.body).user.id as string,
  };
}

describe('Subscription.organizationEvents (story 4.7)', () => {
  before(async () => {
    app = await buildApp(
      {
        logger: {
          level: 'info',
          stream: { write: (line: string) => logLines.push(line) },
        },
      },
      { listen: true },
    );
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    Object.assign(operator, await signUpWithOrg(app, tag));
    Object.assign(other, await signUpWithOrg(app, `${tag}-b`));
    Object.assign(offLadder, await signUpWithOrg(app, `${tag}-role`));
    Object.assign(expired, await signUpWithOrg(app, `${tag}-exp`));
    Object.assign(loner, await signUpAlone(`${tag}-alone`));

    await sql`
      update "member" set "role" = 'auditor'
      where "userId" = ${offLadder.userId}
    `;
    await sql`
      update "session" set "expiresAt" = now() - interval '1 minute'
      where "userId" = ${expired.userId}
    `;
  });

  after(async () => {
    if (!appClosed) await app.close();
    const orgIds = [operator, other, offLadder, expired].map((o) => o.orgId);
    const userIds = [operator, other, offLadder, expired, loner].map(
      (u) => u.userId,
    );
    await sql`delete from "organization" where "id" in ${sql(orgIds)}`;
    await sql`delete from "user" where "id" in ${sql(userIds)}`;
    await sql.end({ timeout: 5 });
  });

  it('sends every bridged event of the active organization, admin-only ones included', async () => {
    const { client, id } = await liveSubscription(
      operator.cookie,
      operator.orgId,
    );
    try {
      const serviceId = await createService(app, operator.cookie);
      const draftId = await openMonitorDraft(
        app,
        operator.cookie,
        operator.orgId,
        serviceId,
      );
      await app.eventBus.drain();
      await settle(operator.orgId);
      const events = await eventsUntilSentinel(client, id);

      const created = events.find((e) => e.eventName === 'service.created');
      assert.ok(created, JSON.stringify(events));
      assert.deepEqual(Object.keys(created).sort(), [
        'aggregateId',
        'aggregateType',
        'eventName',
        'occurredAt',
      ]);
      assert.equal(created.aggregateType, 'service');
      assert.equal(created.aggregateId, serviceId);
      assert.ok(!Number.isNaN(Date.parse(created.occurredAt)));

      // Admin-only: never public, always here.
      const draft = events.find(
        (e) => e.eventName === 'incident.draft_created',
      );
      assert.ok(draft, JSON.stringify(events));
      assert.equal(draft.aggregateType, 'incident');
      assert.equal(draft.aggregateId, draftId);
    } finally {
      await client.close();
    }
  });

  it('sends exactly one resync when the hub asks every subscriber to re-read', async () => {
    const { client, id } = await liveSubscription(
      operator.cookie,
      operator.orgId,
    );
    try {
      const before = Date.now();
      app.realtimeHub.resync();
      await settle(operator.orgId);
      const events = await eventsUntilSentinel(client, id);
      assert.equal(events.length, 1, JSON.stringify(events));
      const [resync] = events;
      assert.equal(resync.eventName, 'resync');
      assert.equal(resync.aggregateType, 'organization');
      assert.equal(resync.aggregateId, operator.orgId);
      // The WSL2 clock steps back by up to 1.4 s (AGENTS.md).
      assert.ok(Date.parse(resync.occurredAt) >= before - 2_000);
    } finally {
      await client.close();
    }
  });

  it("never sends another organization's events", async () => {
    const { client, id } = await liveSubscription(
      operator.cookie,
      operator.orgId,
    );
    try {
      await createService(app, other.cookie);
      await app.eventBus.drain();
      // B's notifications have all arrived before A's sentinel is sent.
      await settle(other.orgId);
      await settle(operator.orgId);
      assert.deepEqual(await eventsUntilSentinel(client, id), []);
    } finally {
      await client.close();
    }
  });

  for (const [name, cookie] of [
    ['no cookie', () => undefined],
    ['a junk cookie', () => 'better-auth.session_token=junk.signature'],
    ['an expired session', () => expired.cookie],
  ] as const) {
    it(`refuses an upgrade with ${name} as UNAUTHENTICATED, then closes it`, async () => {
      const client = await open({ cookie: cookie() });
      const id = client.subscribe(SUBSCRIPTION);
      const error = await assertRefused(client, id);
      assert.equal(error.message, 'Authentication required');
      // A refused credential is a warning, never an error-level line that an
      // anonymous caller could write on demand.
      assert.ok(
        !logged().some(
          (entry) =>
            Number(entry.level) >= 50 &&
            JSON.stringify(entry).includes('Authentication required'),
        ),
        'a refusal is logged below error',
      );
    });
  }

  it('refuses a valid session with no organization as UNAUTHENTICATED', async () => {
    const client = await open({ cookie: loner.cookie });
    await assertRefused(client, client.subscribe(SUBSCRIPTION));
  });

  it('refuses a role off the ladder as UNAUTHENTICATED, and logs it', async () => {
    const client = await open({ cookie: offLadder.cookie });
    await assertRefused(client, client.subscribe(SUBSCRIPTION));
    const entry = logged().find(
      (line) =>
        String(line.msg).includes('unknown role') &&
        String(line.msg).includes(offLadder.userId),
    );
    assert.ok(entry, 'the unknown role is logged');
    assert.equal(entry.level, 40);
    assert.equal(entry.statusCode, 401);
  });

  it('never authenticates from a cookie sent in the connection_init payload', async () => {
    for (const payload of [
      { cookie: operator.cookie },
      { headers: { cookie: operator.cookie } },
    ]) {
      const client = await open({ payload });
      // Sent together, so the second `connection_init` and subscribe arrive
      // after the first subscribe merged the payload into the request's
      // headers, and before the refusal closes the socket.
      const first = client.subscribe(SUBSCRIPTION);
      client.send({ type: 'connection_init', payload });
      const second = client.subscribe(SUBSCRIPTION);

      const refused = new Map<string, string | undefined>();
      while (refused.size < 2) {
        const message = await client.next();
        if (message.type === 'connection_ack') continue;
        assert.equal(message.type, 'error', JSON.stringify(message));
        const [error] = message.payload as GraphqlError[];
        refused.set(String(message.id), error.extensions?.code);
      }
      assert.deepEqual(
        Object.fromEntries(refused),
        { [first]: 'UNAUTHENTICATED', [second]: 'UNAUTHENTICATED' },
        JSON.stringify(payload),
      );
      assert.equal((await client.waitClosed()).code, 4401);
    }
  });

  it('resolves who is subscribing once per socket, however many subscribe', async () => {
    const client = await open();
    const lookups = countSessionLookups();
    let ids: string[];
    try {
      // One frame batch: every subscribe arrives before the first refusal.
      ids = [1, 2, 3].map(() => client.subscribe(SUBSCRIPTION));
      const refused = new Set<string>();
      while (refused.size < ids.length) {
        const message = await client.next();
        assert.equal(message.type, 'error', JSON.stringify(message));
        const [error] = message.payload as GraphqlError[];
        assert.equal(error.extensions?.code, 'UNAUTHENTICATED');
        refused.add(String(message.id));
      }
      assert.deepEqual([...refused].sort(), ids);
      assert.equal((await client.waitClosed()).code, 4401);
    } finally {
      lookups.restore();
    }
    assert.equal(lookups.calls, 1, 'one session lookup for the socket');
  });

  it('masks an unexpected failure and logs the original under its correlation id', async () => {
    const client = await open({ cookie: operator.cookie });
    const getSession = auth.api.getSession;
    // The context lookup's first step, failing the way a lost database would.
    auth.api.getSession = (async () => {
      throw new Error(INTERNAL);
    }) as unknown as typeof getSession;
    let message: WsMessage;
    try {
      client.subscribe(SUBSCRIPTION);
      message = await client.next();
    } finally {
      auth.api.getSession = getSession;
    }

    assert.equal(message.type, 'error', JSON.stringify(message));
    assert.ok(!JSON.stringify(message).includes('ECONNREFUSED'));
    const [error] = message.payload as GraphqlError[];
    assert.equal(error.message, 'Internal Server Error');
    const extensions = error.extensions as {
      code?: string;
      correlationId?: string;
    };
    assert.equal(extensions.code, 'INTERNAL_SERVER_ERROR');
    assert.match(String(extensions.correlationId), /^[0-9a-f-]{36}$/);
    // Not 4401: the session may be fine, so the client should reconnect.
    assert.equal((await client.waitClosed()).code, 4500);

    const entry = logged().find(
      (line) => line.correlationId === extensions.correlationId,
    );
    assert.ok(entry, 'the original is logged under the correlation id');
    assert.equal(entry.level, 50);
    assert.equal((entry.err as { message?: string }).message, INTERNAL);
  });

  it('closes a socket with no accepted subscription by its deadline with 4408, and only that', async () => {
    // Both rows share the one wait: a socket that never initialises, one that
    // initialises and never subscribes, and one whose subscription was
    // accepted, which outlives the deadline and is still sent events.
    const live = await liveSubscription(operator.cookie, operator.orgId);
    const silent = await open({ cookie: operator.cookie, init: false });
    const idle = await open({ cookie: operator.cookie });
    try {
      const started = performance.now();
      const [silentClosed, idleClosed] = await Promise.all([
        silent.waitClosed(SUBSCRIPTION_DEADLINE_MS + 5_000),
        idle.waitClosed(SUBSCRIPTION_DEADLINE_MS + 5_000),
      ]);
      const waited = performance.now() - started;
      assert.equal(silentClosed.code, 4408, JSON.stringify(silentClosed));
      assert.equal(idleClosed.code, 4408, JSON.stringify(idleClosed));
      assert.ok(
        waited >= SUBSCRIPTION_DEADLINE_MS - 1_000,
        `closed after ${waited}ms`,
      );

      // Past the deadline, the accepted subscription is open and still sent.
      app.realtimeHub.resync();
      await settle(operator.orgId);
      const events = await eventsUntilSentinel(live.client, live.id);
      assert.deepEqual(
        events.map((event) => event.eventName),
        ['resync'],
      );
    } finally {
      await Promise.all([live.client, silent, idle].map((c) => c.close()));
    }
  });

  it('caps a socket at MAX_SUBSCRIPTIONS_PER_SOCKET live subscriptions, and keeps them and the socket open', async () => {
    const max = MAX_SUBSCRIPTIONS_PER_SOCKET;
    const client = await open({ cookie: operator.cookie });
    try {
      // One frame batch, so all of them share the one admission, in order.
      const ids = Array.from({ length: max + 1 }, () =>
        client.subscribe(SUBSCRIPTION),
      );
      const error = await assertError(
        client,
        ids[max],
        'TOO_MANY_SUBSCRIPTIONS',
      );
      assert.equal(error.message, 'Too many subscriptions');

      // The first `max` joined the hub before the next was refused.
      await settle(operator.orgId);
      const sent = new Set<string>();
      while (sent.size < max) {
        const message = await client.next();
        const id = String(message.id);
        const event = eventOf(message, id);
        if (event.aggregateType === SENTINEL_AGGREGATE_TYPE) sent.add(id);
      }
      assert.deepEqual([...sent].sort(), ids.slice(0, max).sort());
      const stillOpen = await Promise.race([
        client.closed.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(true), 200)),
      ]);
      assert.ok(stillOpen, 'the socket stays open');
    } finally {
      await client.close();
    }
  });

  for (const [name, id] of [
    ['a short id', 'dup'],
    // Too long to fit in a close reason, which holds 123 bytes.
    ['a 200-character id', 'x'.repeat(200)],
  ] as const) {
    it(`closes a socket that reuses a live subscription id (${name}) with 4409, leaving nothing on the hub`, async () => {
      const hub = countAdminSubscriptions();
      try {
        const client = await open({ cookie: operator.cookie });
        const subscribe = {
          id,
          type: 'subscribe',
          payload: { query: SUBSCRIPTION },
        };
        client.send(subscribe);
        await eventually(
          () => hub.live === 1,
          'the subscription joins the hub',
        );

        client.send(subscribe);
        const closed = await client.waitClosed();
        assert.equal(closed.code, 4409, JSON.stringify(closed));
        await eventually(() => hub.live === 0, 'the hub forgets the socket');
      } finally {
        hub.restore();
      }
    });
  }

  it("frees a subscription's id when the client completes it", async () => {
    const hub = countAdminSubscriptions();
    const client = await open({ cookie: operator.cookie });
    try {
      const id = client.subscribe(SUBSCRIPTION);
      await eventually(() => hub.live === 1, 'the subscription joins the hub');

      client.send({ id, type: 'complete' });
      await awaitComplete(client, id);
      await eventually(() => hub.live === 0, 'the hub forgets it');

      // The same id again: accepted, not a 4409.
      client.send({ id, type: 'subscribe', payload: { query: SUBSCRIPTION } });
      await eventually(() => hub.live === 1, 'the id subscribes again');
      await settle(operator.orgId);
      const event = await awaitEventFor(client, id);
      assert.equal(event.aggregateType, SENTINEL_AGGREGATE_TYPE);
    } finally {
      hub.restore();
      await client.close();
    }
  });

  it('frees a cap slot when the client completes a subscription', async () => {
    const max = MAX_SUBSCRIPTIONS_PER_SOCKET;
    const hub = countAdminSubscriptions();
    const client = await open({ cookie: operator.cookie });
    try {
      const ids = Array.from({ length: max }, () =>
        client.subscribe(SUBSCRIPTION),
      );
      await eventually(() => hub.live === max, `${max} join the hub`);

      client.send({ id: ids[0], type: 'complete' });
      await awaitComplete(client, ids[0]);
      await eventually(() => hub.live === max - 1, 'the hub forgets one');

      const next = client.subscribe(SUBSCRIPTION);
      await eventually(() => hub.live === max, 'the next is accepted');
      await settle(operator.orgId);
      const event = await awaitEventFor(client, next);
      assert.equal(event.aggregateType, SENTINEL_AGGREGATE_TYPE);
    } finally {
      hub.restore();
      await client.close();
    }
  });

  it('joins nothing to the hub when the socket closes while its subscriber is being resolved', async () => {
    const hub = countAdminSubscriptions();
    const getSession = auth.api.getSession;
    let looking: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      looking = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = await open({ cookie: operator.cookie });
    try {
      // The lookup waits until the socket has closed, then answers for real.
      auth.api.getSession = (async (...args: Parameters<typeof getSession>) => {
        looking();
        await released;
        return getSession(...args);
      }) as typeof getSession;
      client.subscribe(SUBSCRIPTION);
      await lookupStarted;
      await client.close();
      release();
      // Nothing is observable when the branch holds, so give the admission
      // (the lookup and its membership query) time to finish.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(hub.calls, 0, 'nothing joined the hub');
      assert.equal(hub.live, 0);
    } finally {
      auth.api.getSession = getSession;
      release();
      hub.restore();
    }
  });

  it('refuses an upgrade from a missing or untrusted Origin with 403', async () => {
    const missing = await upgradeStatus(baseUrl, { cookie: operator.cookie });
    assert.equal(missing.statusCode, 403);
    const evil = await upgradeStatus(baseUrl, {
      cookie: operator.cookie,
      origin: 'http://evil.test',
    });
    assert.equal(evil.statusCode, 403);
    // Without a cookie, while the anonymous bucket has room.
    const anonymousMissing = await upgradeStatus(baseUrl);
    assert.equal(anonymousMissing.statusCode, 403);
    const anonymousEvil = await upgradeStatus(baseUrl, {
      origin: 'http://evil.test',
    });
    assert.equal(anonymousEvil.statusCode, 403);
    const refusal = logged().find(
      (entry) =>
        entry.statusCode === 403 && entry.origin === 'http://evil.test',
    );
    assert.ok(refusal, 'the refused upgrade is logged');
    assert.equal(refusal.level, 40);
    assert.equal(refusal.err, undefined, 'with no stack');
    const trusted = await upgradeStatus(baseUrl, {
      cookie: operator.cookie,
      origin: TEST_ORIGIN,
    });
    assert.equal(trusted.statusCode, 101, 'the same upgrade, trusted');
  });

  it('refuses a query or a mutation over the socket, and runs no resolver', async () => {
    const client = await open({ cookie: operator.cookie });
    try {
      const query = client.subscribe('{ services { id } }');
      const queried = await client.next();
      assert.equal(queried.type, 'error', JSON.stringify(queried));
      assert.equal(queried.id, query);
      assert.equal(
        (queried.payload as GraphqlError[])[0].message,
        'Invalid operation: query',
      );

      const slug = `${tag}-ws-mutation`;
      const mutation = client.subscribe(
        `mutation { createService(input: { name: "${slug}", slug: "${slug}" }) }`,
      );
      const mutated = await client.next();
      assert.equal(mutated.type, 'error', JSON.stringify(mutated));
      assert.equal(mutated.id, mutation);
      assert.equal(
        (mutated.payload as GraphqlError[])[0].message,
        'Invalid operation: mutation',
      );
      await app.eventBus.drain();
      const rows = await withTenantTransaction(
        operator.orgId,
        ({ sql: tx }) => tx`select id from services where slug = ${slug}`,
      );
      assert.equal(rows.length, 0, 'the mutation did not run');
    } finally {
      await client.close();
    }
  });

  it('rations an upgrade without a valid session, and only that', async () => {
    // Its own app: the limiter counts per app, and a spent bucket would
    // answer 429 to every later upgrade in this file. Built while the
    // suite's app is open, since Better Auth's pool ends with the last app.
    const limited = await buildApp({ logger: false });
    const limitedUrl = await limited.listen({ port: 0, host: '127.0.0.1' });
    const clients: SubscriptionClient[] = [];
    try {
      const max = env.publicSurface.rateLimit.max;
      /** A 429 is written and the socket destroyed: the read can be reset. */
      const attempt = async (
        headers: Record<string, string>,
      ): Promise<RawUpgrade | undefined> => {
        try {
          return await upgradeStatus(limitedUrl, headers);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
            return undefined;
          }
          throw error;
        }
      };

      const junk = {
        origin: TEST_ORIGIN,
        cookie: 'better-auth.session_token=junk.signature',
      };
      let refused: RawUpgrade | undefined;
      for (let sent = 1; sent <= max + 2 && !refused; sent += 1) {
        const upgrade = await attempt(junk);
        if (upgrade?.statusCode === 429) refused = upgrade;
        else if (upgrade) assert.equal(upgrade.statusCode, 101);
      }
      // Past the limit every upgrade is a 429, so a reset read is retried.
      for (let retries = 0; !refused && retries < 10; retries += 1) {
        refused = await attempt(junk);
      }
      assert.ok(refused, `no 429 within ${max + 2} upgrades`);
      assert.equal(refused.statusCode, 429);
      assert.ok(Number(refused.headers['retry-after']) > 0, 'Retry-After');

      // An anonymous cross-site upgrade is rationed before it is refused.
      let crossSite: RawUpgrade | undefined;
      for (let retries = 0; !crossSite && retries < 10; retries += 1) {
        crossSite = await attempt({ origin: 'http://evil.test' });
      }
      assert.equal(crossSite?.statusCode, 429);

      // A valid session is not rationed, whatever its membership.
      for (const cookie of [loner.cookie, offLadder.cookie]) {
        const client = await open({ cookie }, limitedUrl);
        clients.push(client);
        await assertRefused(client, client.subscribe(SUBSCRIPTION));
      }
      // And a member's subscription is accepted: it is sent the hub's resync.
      const member = await open({ cookie: operator.cookie }, limitedUrl);
      clients.push(member);
      const id = member.subscribe(SUBSCRIPTION);
      let resync: OrganizationEvent | undefined;
      for (let attempt = 1; !resync; attempt += 1) {
        assert.ok(attempt <= 10, 'the member subscription never went live');
        // A resync sent before the subscription joins the hub is missed.
        limited.realtimeHub.resync();
        const message = await member.next(500).catch(() => undefined);
        if (message) resync = eventOf(message, id);
      }
      assert.equal(resync.eventName, 'resync');
      assert.equal(resync.aggregateId, operator.orgId);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await limited.close();
    }
  });

  // Last: it closes the suite's app.
  it('closes every socket on app.close(), even one that never answers', async () => {
    const { client, id } = await liveSubscription(
      operator.cookie,
      operator.orgId,
    );
    const raw = await rawUpgrade(baseUrl, {
      cookie: operator.cookie,
      origin: TEST_ORIGIN,
    });
    assert.equal(raw.statusCode, 101);
    const socket = raw.socket;
    assert.ok(socket);
    // Read, so the end is noticed, and never write: no close frame goes back.
    socket.on('data', () => {});
    socket.on('error', () => {});
    const rawClosed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );

    const started = performance.now();
    await app.close();
    appClosed = true;
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_000, `app.close() took ${elapsed}ms`);

    // The subscription is completed, then the socket closed as going away.
    let message = await client.next();
    while (message.type === 'next') message = await client.next();
    assert.equal(message.type, 'complete', JSON.stringify(message));
    assert.equal(message.id, id);
    const closed = await client.waitClosed();
    assert.equal(closed.code, 1001, JSON.stringify(closed));
    await rawClosed;
  });
});
