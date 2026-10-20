import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RealtimeEvent } from '@/shared/realtime/realtime-event';
import {
  createRealtimeHub,
  type RealtimeLogger,
  type RealtimeSignal,
} from '@/shared/realtime/realtime-hub';

/**
 * Story 4.4: the hub fans a notification out to one organization's
 * subscribers, admin and public.
 *
 * Needs no database; runs with the unit suite.
 */

const ORG_A = 'org_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'org_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function event(orgId: string, eventName: string): RealtimeEvent {
  return {
    eventName,
    orgId,
    aggregateType: eventName.slice(0, eventName.indexOf('.')),
    aggregateId: `${eventName}-1`,
    occurredAt: '2026-10-20T12:00:00.000Z',
    version: 1,
  };
}

function recordingLogger() {
  const errors: Array<{ obj: object; msg: string }> = [];
  const warns: Array<{ obj: object; msg: string }> = [];
  const log: RealtimeLogger = {
    warn: (obj, msg) => warns.push({ obj, msg }),
    error: (obj, msg) => errors.push({ obj, msg }),
  };
  return { log, errors, warns };
}

function collector() {
  const signals: RealtimeSignal[] = [];
  return { signals, fn: (signal: RealtimeSignal) => void signals.push(signal) };
}

const names = (signals: RealtimeSignal[]) =>
  signals.map((signal) =>
    signal.kind === 'event' ? signal.event.eventName : signal.kind,
  );

/** Lets a rejected promise's handler run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('Story 4.4: the realtime hub', () => {
  it('delivers to its own organization only, and to public only what is whitelisted', () => {
    const hub = createRealtimeHub(recordingLogger().log);
    const adminA = collector();
    const publicA = collector();
    const adminB = collector();
    const publicB = collector();
    hub.subscribeAdmin(ORG_A, adminA.fn);
    hub.subscribePublic(ORG_A, publicA.fn);
    hub.subscribeAdmin(ORG_B, adminB.fn);
    hub.subscribePublic(ORG_B, publicB.fn);

    hub.publish(event(ORG_A, 'incident.created'));
    hub.publish(event(ORG_A, 'incident.draft_created'));
    hub.publish(event(ORG_A, 'monitor.threshold_breached'));
    hub.publish(event(ORG_A, 'service.status_changed'));

    assert.deepEqual(names(adminA.signals), [
      'incident.created',
      'incident.draft_created',
      'monitor.threshold_breached',
      'service.status_changed',
    ]);
    assert.deepEqual(names(publicA.signals), [
      'incident.created',
      'service.status_changed',
    ]);
    assert.deepEqual(adminB.signals, []);
    assert.deepEqual(publicB.signals, []);
    assert.deepEqual(adminA.signals[0], {
      kind: 'event',
      event: event(ORG_A, 'incident.created'),
    });
  });

  it('keeps delivering past a subscriber that throws or rejects, and logs each', async () => {
    const { log, errors } = recordingLogger();
    const hub = createRealtimeHub(log);
    const thrown = new Error('subscriber threw');
    const rejected = new Error('subscriber rejected');
    hub.subscribeAdmin(ORG_A, () => {
      throw thrown;
    });
    hub.subscribeAdmin(ORG_A, () => Promise.reject(rejected));
    const after = collector();
    hub.subscribeAdmin(ORG_A, after.fn);

    hub.publish(event(ORG_A, 'incident.created'));
    await tick();

    assert.deepEqual(names(after.signals), ['incident.created']);
    assert.equal(errors.length, 2);
    assert.deepEqual(
      errors.map(({ obj }) => (obj as { err: unknown }).err),
      [thrown, rejected],
    );
  });

  it('counts one function subscribed twice as two subscriptions', () => {
    const hub = createRealtimeHub(recordingLogger().log);
    const twice = collector();
    hub.subscribeAdmin(ORG_A, twice.fn);
    hub.subscribeAdmin(ORG_A, twice.fn);

    hub.publish(event(ORG_A, 'incident.created'));
    assert.equal(twice.signals.length, 2);
  });

  it('unsubscribes idempotently, leaving the other subscription alone', () => {
    const hub = createRealtimeHub(recordingLogger().log);
    const gone = collector();
    const kept = collector();
    const off = hub.subscribeAdmin(ORG_A, gone.fn);
    hub.subscribeAdmin(ORG_A, kept.fn);

    off();
    off();
    hub.publish(event(ORG_A, 'incident.created'));

    assert.deepEqual(gone.signals, []);
    assert.deepEqual(names(kept.signals), ['incident.created']);
  });

  it('forgets an organization whose last subscriber left, and takes it back later', () => {
    const hub = createRealtimeHub(recordingLogger().log);
    const first = collector();
    const offFirst = hub.subscribePublic(ORG_A, first.fn);
    offFirst();

    const second = collector();
    hub.subscribePublic(ORG_A, second.fn);
    // A stale unsubscribe must not drop the organization's new entry.
    offFirst();
    hub.publish(event(ORG_A, 'incident.created'));

    assert.deepEqual(first.signals, []);
    assert.deepEqual(names(second.signals), ['incident.created']);
  });

  it('lets a subscriber unsubscribe while it receives', () => {
    const hub = createRealtimeHub(recordingLogger().log);
    const later = collector();
    let off = () => {};
    let calls = 0;
    off = hub.subscribeAdmin(ORG_A, () => {
      calls += 1;
      off();
    });
    hub.subscribeAdmin(ORG_A, later.fn);

    hub.publish(event(ORG_A, 'incident.created'));
    hub.publish(event(ORG_A, 'incident.updated'));

    assert.equal(calls, 1);
    assert.deepEqual(names(later.signals), [
      'incident.created',
      'incident.updated',
    ]);
  });

  it('sends resync to every subscriber of every organization, on both channels', () => {
    const hub = createRealtimeHub(recordingLogger().log);
    const all = [collector(), collector(), collector(), collector()];
    hub.subscribeAdmin(ORG_A, all[0].fn);
    hub.subscribePublic(ORG_A, all[1].fn);
    hub.subscribeAdmin(ORG_B, all[2].fn);
    hub.subscribePublic(ORG_B, all[3].fn);

    hub.resync();

    for (const { signals } of all) {
      assert.deepEqual(signals, [{ kind: 'resync' }]);
    }
  });

  it('closes every subscriber once, then does nothing more', () => {
    const { log, errors } = recordingLogger();
    const hub = createRealtimeHub(log);
    const all = [collector(), collector(), collector()];
    hub.subscribeAdmin(ORG_A, all[0].fn);
    hub.subscribePublic(ORG_A, all[1].fn);
    const offB = hub.subscribeAdmin(ORG_B, all[2].fn);
    hub.subscribeAdmin(ORG_B, () => {
      throw new Error('closing subscriber threw');
    });

    hub.close();
    hub.close();
    hub.publish(event(ORG_A, 'incident.created'));
    hub.resync();
    offB();

    for (const { signals } of all) {
      assert.deepEqual(signals, [{ kind: 'closed' }]);
    }
    assert.equal(errors.length, 1, 'a throw while closing is logged too');

    const late = collector();
    const offLate = hub.subscribePublic(ORG_A, late.fn);
    hub.publish(event(ORG_A, 'incident.created'));
    hub.resync();
    offLate();
    assert.deepEqual(late.signals, [{ kind: 'closed' }]);
  });
});
