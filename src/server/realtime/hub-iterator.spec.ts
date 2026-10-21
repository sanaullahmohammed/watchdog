import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adminSignals,
  MAX_QUEUED_SIGNALS,
  type OrganizationEvent,
} from '@/server/realtime/hub-iterator';
import type { RealtimeEvent } from '@/shared/realtime/realtime-event';
import {
  createRealtimeHub,
  type RealtimeHub,
} from '@/shared/realtime/realtime-hub';

/**
 * Story 4.7: an admin subscription's queue over the hub.
 *
 * Needs no database; runs with the unit suite.
 */

const ORG_A = 'org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'org_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const silent = { warn() {}, error() {} };

function event(orgId: string, n: number, eventName = 'service.updated') {
  return {
    eventName,
    orgId,
    aggregateType: 'service',
    aggregateId: `service-${n}`,
    occurredAt: '2026-10-21T12:00:00.000Z',
    version: 1,
  } satisfies RealtimeEvent;
}

function signal(n: number, eventName = 'service.updated'): OrganizationEvent {
  return {
    eventName,
    aggregateType: 'service',
    aggregateId: `service-${n}`,
    occurredAt: '2026-10-21T12:00:00.000Z',
  };
}

function assertResync(value: OrganizationEvent | undefined) {
  assert.ok(value);
  assert.equal(value.eventName, 'resync');
  assert.equal(value.aggregateType, 'organization');
  assert.equal(value.aggregateId, ORG_A);
  assert.ok(!Number.isNaN(Date.parse(value.occurredAt)), value.occurredAt);
}

/** Counts the admin subscriptions the iterator holds on a real hub. */
function countingHub() {
  const hub = createRealtimeHub(silent);
  let open = 0;
  const counted: RealtimeHub = {
    ...hub,
    subscribeAdmin(orgId, fn) {
      open += 1;
      const off = hub.subscribeAdmin(orgId, fn);
      let done = false;
      return () => {
        if (!done) open -= 1;
        done = true;
        off();
      };
    },
  };
  return { hub: counted, open: () => open };
}

describe('adminSignals', () => {
  it('maps a hub event to its four fields', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    hub.publish(event(ORG_A, 1, 'incident.draft_created'));
    const { value, done } = await signals.next();
    assert.equal(done, false);
    assert.deepEqual(value, signal(1, 'incident.draft_created'));
    await signals.return?.();
  });

  it("delivers only its own organization's events", async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    hub.publish(event(ORG_B, 1));
    hub.publish(event(ORG_A, 2));
    assert.deepEqual((await signals.next()).value, signal(2));
    await signals.return?.();
  });

  it('resolves a pending next() when a signal arrives', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    const pending = signals.next();
    hub.publish(event(ORG_A, 1));
    assert.deepEqual((await pending).value, signal(1));
    await signals.return?.();
  });

  it('maps a resync to the organization', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    hub.resync();
    assertResync((await signals.next()).value);
    await signals.return?.();
  });

  it('coalesces a resync while one is already queued', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    hub.resync();
    hub.publish(event(ORG_A, 1));
    hub.resync();
    hub.publish(event(ORG_A, 2));
    assertResync((await signals.next()).value);
    assert.deepEqual((await signals.next()).value, signal(1));
    assert.deepEqual((await signals.next()).value, signal(2));
    hub.close();
    assert.equal((await signals.next()).done, true);
  });

  it('queues a resync again once the last one has been read', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    hub.resync();
    assertResync((await signals.next()).value);
    hub.resync();
    assertResync((await signals.next()).value);
    await signals.return?.();
  });

  it('turns an overflowing queue into one resync, with later events behind it', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    for (let n = 0; n < MAX_QUEUED_SIGNALS + 1; n += 1) {
      hub.publish(event(ORG_A, n));
    }
    hub.publish(event(ORG_A, 999));
    hub.close();

    const read: OrganizationEvent[] = [];
    for await (const value of signals) read.push(value);
    assert.equal(read.length, 2, JSON.stringify(read.slice(0, 3)));
    assertResync(read[0]);
    assert.deepEqual(read[1], signal(999));
  });

  it('keeps every signal up to the bound', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    for (let n = 0; n < MAX_QUEUED_SIGNALS; n += 1) {
      hub.publish(event(ORG_A, n));
    }
    hub.close();
    const read: OrganizationEvent[] = [];
    for await (const value of signals) read.push(value);
    assert.equal(read.length, MAX_QUEUED_SIGNALS);
    assert.deepEqual(read[0], signal(0));
    assert.deepEqual(read.at(-1), signal(MAX_QUEUED_SIGNALS - 1));
  });

  it('ends on closed after the queued signals have been read', async () => {
    const { hub, open } = countingHub();
    const signals = adminSignals(hub, ORG_A);
    hub.publish(event(ORG_A, 1));
    hub.publish(event(ORG_A, 2));
    hub.close();
    assert.equal(open(), 0, 'closed unsubscribes');
    hub.publish(event(ORG_A, 3));
    assert.deepEqual((await signals.next()).value, signal(1));
    assert.deepEqual((await signals.next()).value, signal(2));
    assert.deepEqual(await signals.next(), { done: true, value: undefined });
    assert.deepEqual(await signals.next(), { done: true, value: undefined });
  });

  it('resolves a pending next() with done on closed', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    const pending = signals.next();
    hub.close();
    assert.deepEqual(await pending, { done: true, value: undefined });
  });

  it('ends at once when the hub is closed during the subscribe', async () => {
    const { hub, open } = countingHub();
    hub.close();
    const signals = adminSignals(hub, ORG_A);
    assert.equal(open(), 0, 'the subscription is given back');
    assert.deepEqual(await signals.next(), { done: true, value: undefined });
  });

  it('resolves a pending next() with done on return(), and unsubscribes', async () => {
    const { hub, open } = countingHub();
    const signals = adminSignals(hub, ORG_A);
    assert.equal(open(), 1);
    const pending = signals.next();
    assert.deepEqual(await signals.return?.(), {
      done: true,
      value: undefined,
    });
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.equal(open(), 0);
    hub.publish(event(ORG_A, 1));
    assert.deepEqual(await signals.next(), { done: true, value: undefined });
  });

  it('drops what is queued on return()', async () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    hub.publish(event(ORG_A, 1));
    await signals.return?.();
    assert.deepEqual(await signals.next(), { done: true, value: undefined });
  });

  it('is idempotent on return()', async () => {
    let unsubscribed = 0;
    const hub: Pick<RealtimeHub, 'subscribeAdmin'> = {
      subscribeAdmin: () => () => {
        unsubscribed += 1;
      },
    };
    const signals = adminSignals(hub, ORG_A);
    await signals.return?.();
    await signals.return?.();
    assert.equal(unsubscribed, 1);
    assert.deepEqual(await signals.return?.(), {
      done: true,
      value: undefined,
    });
    assert.equal(unsubscribed, 1);
  });

  it('is its own async iterator', () => {
    const hub = createRealtimeHub(silent);
    const signals = adminSignals(hub, ORG_A);
    assert.equal(signals[Symbol.asyncIterator](), signals);
    void signals.return?.();
  });
});
