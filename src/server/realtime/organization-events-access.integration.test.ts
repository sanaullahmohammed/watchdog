import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import { auth } from '@/server/auth/auth';
import { buildApp } from '@/server/build-app';
import type { OrganizationEvent } from '@/server/realtime/hub-iterator';
import sql from '@/shared/db/postgres';
import { createService } from '@/shared/testing/fixtures';
import {
  openSubscription,
  type SubscriptionClient,
  type WsMessage,
} from '@/shared/testing/graphql';
import { subscribeForOrg } from '@/shared/testing/notifications';
import { addMember, signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 4.8: an admin subscription's socket re-checks its access every
 * `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`, and closes when it is lost.
 *
 * The interval is 1 s here, set in-process: the resolver reads it each time
 * it schedules a re-check. "Within one interval" is a close within the
 * interval plus 2 s. A re-check is told apart from every other session lookup
 * by the `disableRefresh` it passes, so a fake `getSession` can fail or hold
 * only the re-checks. The close test runs last because it closes the app.
 */

const tag = `orgacc-${randomBytes(4).toString('hex')}`;
const SUBSCRIPTION = `subscription {
  organizationEvents { eventName aggregateType aggregateId occurredAt }
}`;
const SENTINEL_AGGREGATE_TYPE = 'test.sentinel';
const INTERVAL_SECONDS = 1;
const INTERVAL_MS = INTERVAL_SECONDS * 1_000;
/** One interval, and the slack "within one interval" allows. */
const WITHIN_ONE_INTERVAL_MS = INTERVAL_MS + 2_000;
/** What a failed lookup says, which only the log may read. */
const INTERNAL = 'connect ECONNREFUSED 10.20.30.40:5432 (db.internal)';

const originalInterval = env.realtime.adminSubscriptionRecheckSeconds;

let app: FastifyInstance;
let appClosed = false;
let baseUrl = '';
const logLines: string[] = [];
const orgIds: string[] = [];
const userIds: string[] = [];

type Operator = { cookie: string; userId: string; orgId: string };

/** A signed-up operator with an organization, cleaned up after the suite. */
async function operator(label: string): Promise<Operator & { email: string }> {
  const created = await signUpWithOrg(app, `${tag}-${label}`);
  orgIds.push(created.orgId);
  userIds.push(created.userId);
  return { ...created, email: `${tag}-${label}@example.test` };
}

const open = (cookie: string) =>
  openSubscription(baseUrl, { origin: TEST_ORIGIN, cookie });

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
 * drained, a sentinel is sent and heard. A live subscription of that
 * organization is sent the sentinel too, after everything sent before it.
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
  const client = await open(cookie);
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

/** The socket closes with `code` within `timeoutMs`. */
async function assertClosedWith(
  client: SubscriptionClient,
  code: number,
  timeoutMs = WITHIN_ONE_INTERVAL_MS,
) {
  const closed = await client.waitClosed(timeoutMs);
  assert.equal(closed.code, code, JSON.stringify(closed));
  assert.equal(
    closed.reason,
    code === 4401 ? 'Unauthorized' : 'Internal error',
  );
}

/**
 * Nothing reaches a closed socket: what it was sent before the close is read
 * away, the organization is settled, and no message has arrived since.
 */
async function assertNothingAfterClose(
  client: SubscriptionClient,
  orgId: string,
) {
  for (;;) {
    const before = await client.next(50).catch(() => undefined);
    if (!before) break;
  }
  await settle(orgId);
  const afterClose = await client.next(300).catch(() => undefined);
  assert.equal(afterClose, undefined, JSON.stringify(afterClose));
}

/** The socket is still open after `ms`. */
async function stillOpenAfter(client: SubscriptionClient, ms: number) {
  const open = await Promise.race([
    client.closed.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms)),
  ]);
  assert.ok(open, `the socket is still open after ${ms}ms`);
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

type GetSession = typeof auth.api.getSession;
type GetSessionArgs = Parameters<GetSession>;

const isRecheck = (args: GetSessionArgs) =>
  (args[0] as { query?: { disableRefresh?: boolean } } | undefined)?.query
    ?.disableRefresh === true;

/**
 * Hands every re-check's session lookup to `recheck`, and every other lookup
 * to the real one, until restored. `calls` counts the re-checks.
 */
function fakeRechecks(
  recheck: (real: GetSession, args: GetSessionArgs) => Promise<unknown>,
) {
  const getSession = auth.api.getSession;
  const fake = { calls: 0, restore: () => {} };
  auth.api.getSession = ((...args: GetSessionArgs) => {
    if (!isRecheck(args)) return getSession(...args);
    fake.calls += 1;
    return recheck(getSession, args);
  }) as GetSession;
  fake.restore = () => {
    auth.api.getSession = getSession;
  };
  return fake;
}

/**
 * Counts the hub's admin subscriptions made while it is installed: each
 * `subscribeAdmin` call adds one, and its first unsubscribe removes it.
 */
function countAdminSubscriptions() {
  const hub = app.realtimeHub;
  const subscribeAdmin = hub.subscribeAdmin;
  const counter = { live: 0, restore: () => {} };
  hub.subscribeAdmin = (orgId, fn) => {
    const off = subscribeAdmin.call(hub, orgId, fn);
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

async function signOut(cookie: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { cookie, origin: TEST_ORIGIN },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function setActive(cookie: string, organizationId: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    headers: { cookie, origin: TEST_ORIGIN },
    payload: { organizationId },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function removeMember(
  owner: { cookie: string; orgId: string },
  memberId: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/remove-member',
    headers: { cookie: owner.cookie, origin: TEST_ORIGIN },
    payload: { memberIdOrEmail: memberId, organizationId: owner.orgId },
  });
  assert.equal(response.statusCode, 200, response.body);
}

describe('Subscription.organizationEvents access re-check (story 4.8)', () => {
  before(async () => {
    env.realtime.adminSubscriptionRecheckSeconds = INTERVAL_SECONDS;
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
  });

  after(async () => {
    env.realtime.adminSubscriptionRecheckSeconds = originalInterval;
    if (app && !appClosed) await app.close();
    if (orgIds.length > 0) {
      await sql`delete from "organization" where "id" in ${sql(orgIds)}`;
    }
    if (userIds.length > 0) {
      await sql`delete from "user" where "id" in ${sql(userIds)}`;
    }
    await sql.end({ timeout: 5 });
  });

  it('closes with 4401 within one interval of a sign-out, and logs it as a warning', async () => {
    const op = await operator('out');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    try {
      const logged0 = logLines.length;
      await signOut(op.cookie);
      await assertClosedWith(client, 4401);
      await assertNothingAfterClose(client, op.orgId);

      const entry = logged()
        .slice(logged0)
        .find((line) => line.msg === 'Subscription access lost');
      assert.ok(entry, 'the lost access is logged');
      assert.equal(entry.level, 40);
      assert.equal(entry.statusCode, 401);
      assert.equal(entry.err, undefined, 'with no stack');
      assert.equal(entry.userId, op.userId, 'naming whose access was lost');
      assert.equal(entry.orgId, op.orgId);
    } finally {
      await client.close();
    }
  });

  it('closes with 4401 within one interval of the session expiring', async () => {
    const op = await operator('exp');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    try {
      await sql`
        update "session" set "expiresAt" = now() - interval '1 minute'
        where "userId" = ${op.userId}
      `;
      await assertClosedWith(client, 4401);
      await assertNothingAfterClose(client, op.orgId);
    } finally {
      await client.close();
    }
  });

  it('closes with 4401 within one interval of removal from the organization, ending its subscription', async () => {
    const owner = await operator('rm-owner');
    const member = await operator('rm-member');
    const memberId = await addMember(app, owner, member);
    await setActive(member.cookie, owner.orgId);
    const hub = countAdminSubscriptions();
    try {
      const { client } = await liveSubscription(member.cookie, owner.orgId);
      try {
        assert.equal(hub.live, 1);
        await removeMember(owner, memberId);
        await assertClosedWith(client, 4401);
        await eventually(() => hub.live === 0, 'the hub forgets the socket');

        // An event of the organization after the close reaches nothing.
        await createService(app, owner.cookie);
        await app.eventBus.drain();
        await assertNothingAfterClose(client, owner.orgId);
      } finally {
        await client.close();
      }
    } finally {
      hub.restore();
    }
  });

  it('closes with 4401 when the membership role goes off the ladder', async () => {
    const op = await operator('role');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    try {
      await sql`
        update "member" set "role" = 'auditor'
        where "userId" = ${op.userId} and "organizationId" = ${op.orgId}
      `;
      await assertClosedWith(client, 4401);
      await assertNothingAfterClose(client, op.orgId);
    } finally {
      await client.close();
    }
  });

  it('checks the admitted organization, not the active one: switching away changes nothing', async () => {
    const a = await operator('sw-a');
    // The operator's own organization is B.
    const x = await operator('sw-x');
    const memberId = await addMember(app, a, x);
    await setActive(x.cookie, a.orgId);
    const { client, id } = await liveSubscription(x.cookie, a.orgId);
    const rechecks = fakeRechecks((real, args) => real(...args));
    try {
      await setActive(x.cookie, x.orgId);
      await eventually(
        () => rechecks.calls >= 3,
        'three re-checks',
        3 * WITHIN_ONE_INTERVAL_MS,
      );
      await stillOpenAfter(client, 0);

      // Still sent A's events.
      const serviceId = await createService(app, a.cookie);
      await app.eventBus.drain();
      await settle(a.orgId);
      const events = await eventsUntilSentinel(client, id);
      assert.ok(
        events.some(
          (event) =>
            event.eventName === 'service.created' &&
            event.aggregateId === serviceId,
        ),
        JSON.stringify(events),
      );

      // Removal from A, the admitted organization, still closes it.
      await removeMember(a, memberId);
      await assertClosedWith(client, 4401);
      await assertNothingAfterClose(client, a.orgId);
    } finally {
      rechecks.restore();
      await client.close();
    }
  });

  it('keeps a socket that still has access open, and never refreshes its session', async () => {
    const op = await operator('keep');
    // The control: a session aged the same way, read by a plain lookup.
    const control = await operator('keep-control');
    const { client, id } = await liveSubscription(op.cookie, op.orgId);
    const rechecks = fakeRechecks((real, args) => real(...args));
    try {
      // Past Better Auth's updateAge (1 day) of its 7-day expiry, so a plain
      // `getSession` would refresh it now.
      const age = (userId: string) => sql`
        update "session"
        set "expiresAt" = now() + interval '5 days',
            "updatedAt" = now() - interval '2 days'
        where "userId" = ${userId}
      `;
      const rowOf = (userId: string) => sql<
        { token: string; expiresAt: Date; updatedAt: Date }[]
      >`
        select "token", "expiresAt", "updatedAt" from "session"
        where "userId" = ${userId}
      `;
      await age(op.userId);
      await age(control.userId);
      const before = await rowOf(op.userId);
      assert.equal(before.length, 1);

      // Four started, so three have finished.
      await eventually(
        () => rechecks.calls >= 4,
        'three completed re-checks',
        4 * WITHIN_ONE_INTERVAL_MS,
      );
      await stillOpenAfter(client, 0);
      assert.deepEqual(
        await rowOf(op.userId),
        before,
        'the session row is unchanged',
      );

      // The setup would refresh: a plain lookup changes the control's row.
      const controlBefore = await rowOf(control.userId);
      assert.ok(
        await auth.api.getSession({
          headers: new Headers({ cookie: control.cookie }),
        }),
      );
      assert.notDeepEqual(
        await rowOf(control.userId),
        controlBefore,
        'a plain getSession refreshes an aged session',
      );

      // And it is still sent the organization's events.
      app.realtimeHub.resync();
      await settle(op.orgId);
      const events = await eventsUntilSentinel(client, id);
      assert.deepEqual(
        events.map((event) => event.eventName),
        ['resync'],
      );
    } finally {
      rechecks.restore();
      await client.close();
    }
  });

  it('closes with 4500 when a re-check lookup fails, and logs it with a correlation id', async () => {
    const op = await operator('fail');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    const rechecks = fakeRechecks(async () => {
      throw new Error(INTERNAL);
    });
    try {
      await assertClosedWith(client, 4500);
    } finally {
      rechecks.restore();
      await client.close();
    }
    const entry = logged().find(
      (line) =>
        (line.err as { message?: string } | undefined)?.message === INTERNAL,
    );
    assert.ok(entry, 'the failure is logged');
    assert.equal(entry.level, 50);
    assert.match(String(entry.correlationId), /^[0-9a-f-]{36}$/);
  });

  it('closes with 4500 when a re-check lookup never settles, and logs it', async () => {
    const op = await operator('hang');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    const rechecks = fakeRechecks(() => new Promise(() => {}));
    try {
      const started = performance.now();
      // One interval to the re-check, then min(interval, 10 s) for its lookup.
      await assertClosedWith(
        client,
        4500,
        WITHIN_ONE_INTERVAL_MS + INTERVAL_MS,
      );
      const waited = performance.now() - started;
      assert.ok(waited >= INTERVAL_MS, `closed after ${waited}ms`);
    } finally {
      rechecks.restore();
      await client.close();
    }
    const entry = logged().find((line) =>
      String((line.err as { message?: string } | undefined)?.message).includes(
        'did not settle',
      ),
    );
    assert.ok(entry, 'the hung lookup is logged');
    assert.equal(entry.level, 50);
    assert.match(String(entry.correlationId), /^[0-9a-f-]{36}$/);
  });

  it('closes an idle socket, whose every subscription was completed, when access is lost', async () => {
    const op = await operator('idle');
    const { client, id } = await liveSubscription(op.cookie, op.orgId);
    try {
      client.send({ id, type: 'complete' });
      for (;;) {
        const message = await client.next();
        if (message.type === 'next') continue;
        assert.equal(message.type, 'complete', JSON.stringify(message));
        assert.equal(message.id, id);
        break;
      }
      await signOut(op.cookie);
      // Closed, so a later subscribe cannot reuse the cached admission.
      await assertClosedWith(client, 4401);
    } finally {
      await client.close();
    }
  });

  it('runs one re-check loop per socket, however many subscriptions it accepts', async () => {
    const op = await operator('one-loop');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    try {
      const second = client.subscribe(SUBSCRIPTION);
      // Read until the second subscription is sent a sentinel too.
      let live = false;
      for (let attempt = 1; !live; attempt += 1) {
        assert.ok(attempt <= 10, 'the second subscription never went live');
        await settle(op.orgId);
        for (;;) {
          const message = await client.next(500).catch(() => undefined);
          if (!message) break;
          if (message.id === second) live = true;
        }
      }

      const rechecks = fakeRechecks((real, args) => real(...args));
      const started = performance.now();
      try {
        await new Promise((resolve) => setTimeout(resolve, 5 * INTERVAL_MS));
      } finally {
        rechecks.restore();
      }
      const intervals = Math.ceil((performance.now() - started) / INTERVAL_MS);
      assert.ok(rechecks.calls >= 1, 'the socket was re-checked');
      assert.ok(
        rechecks.calls <= intervals + 1,
        `${rechecks.calls} re-checks in ${intervals} intervals`,
      );
    } finally {
      await client.close();
    }
  });

  it('neither logs nor closes when the socket closed while its lookup was held, even if access was lost', async () => {
    const op = await operator('held-false');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    let started: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let answer: (session: null) => void = () => {};
    // No session: on an open socket this would be lost access.
    const held = new Promise<null>((resolve) => {
      answer = resolve;
    });
    const rechecks = fakeRechecks(() => {
      started();
      return held;
    });
    try {
      await lookupStarted;
      const logged0 = logLines.length;
      await client.close();
      answer(null);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const lost = logged()
        .slice(logged0)
        .filter((line) => line.msg === 'Subscription access lost');
      assert.deepEqual(lost, [], 'a closed socket is never logged');
    } finally {
      rechecks.restore();
      answer(null);
    }
  });

  // Last: it closes the suite's app.
  it('lets app.close() finish while a re-check is held, and the held re-check then does nothing', async () => {
    const op = await operator('close');
    const { client } = await liveSubscription(op.cookie, op.orgId);
    let started: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let fail: (error: Error) => void = () => {};
    const held = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const rechecks = fakeRechecks(() => {
      started();
      return held;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await lookupStarted;
      const logged0 = logLines.length;
      await app.close();
      appClosed = true;

      fail(new Error(INTERNAL));
      // Past the held lookup's own deadline, min(interval, 10 s), too.
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS + 500));

      const closed = await client.waitClosed();
      assert.equal(closed.code, 1001, JSON.stringify(closed));
      const later = logged()
        .slice(logged0)
        .filter(
          (line) =>
            line.msg === 'Subscription access lost' || Number(line.level) >= 50,
        );
      assert.deepEqual(later, [], 'the held re-check logs nothing');
      assert.deepEqual(unhandled, [], 'and throws nothing');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      rechecks.restore();
      await client.close();
    }
  });
});
