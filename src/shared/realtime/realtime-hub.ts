import { isPublicEvent } from '@/shared/realtime/event-visibility';
import type { RealtimeEvent } from '@/shared/realtime/realtime-event';

/**
 * The api's in-memory fan-out of what its `LISTEN` hears (story 4.4).
 *
 * One hub per app. It holds no connection and reads no table: the listener
 * (`notify-listener.ts`) hands it each validated notification, and it delivers
 * that to the organization's subscribers. Admin subscribers get every bridged
 * event; public subscribers only those on the public whitelist. The streams
 * (4.5-4.6) and the admin subscriptions (4.7-4.8) are its subscribers.
 *
 * Delivery is synchronous and in the order notifications arrive, and each
 * subscriber is isolated: one that throws or rejects is logged and the rest
 * still receive.
 */

export type RealtimeSignal =
  | { kind: 'event'; event: RealtimeEvent }
  /** Notifications may have been lost: re-read rather than trust what you hold. */
  | { kind: 'resync' }
  /** The hub is closing; nothing more will arrive. Sent once, last. */
  | { kind: 'closed' };

export type RealtimeSubscriber = (
  signal: RealtimeSignal,
) => void | Promise<void>;

/** What the hub and the listener log through; the app's logger satisfies it. */
export type RealtimeLogger = {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type RealtimeHub = {
  /** Every whitelisted event for the organization, plus `resync` and `closed`. */
  subscribePublic(orgId: string, fn: RealtimeSubscriber): () => void;
  /** Every bridged event for the organization, plus `resync` and `closed`. */
  subscribeAdmin(orgId: string, fn: RealtimeSubscriber): () => void;
  publish(event: RealtimeEvent): void;
  /** Tells every subscriber, of every organization, to re-read. */
  resync(): void;
  /** Sends `closed` to every subscriber and forgets them all. */
  close(): void;
};

type Channel = 'public' | 'admin';

/** One subscription. An object, so subscribing one function twice is two subscriptions. */
type Subscription = { fn: RealtimeSubscriber };

export function createRealtimeHub(log: RealtimeLogger): RealtimeHub {
  const channels: Record<Channel, Map<string, Set<Subscription>>> = {
    public: new Map(),
    admin: new Map(),
  };
  let closed = false;

  function report(
    error: unknown,
    channel: Channel,
    orgId: string,
    signal: RealtimeSignal,
  ) {
    log.error(
      { err: error, channel, orgId, signal: signal.kind },
      'Realtime subscriber failed',
    );
  }

  function deliver(
    subscription: Subscription,
    channel: Channel,
    orgId: string,
    signal: RealtimeSignal,
  ) {
    try {
      const result = subscription.fn(signal);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (error: unknown) =>
          report(error, channel, orgId, signal),
        );
      }
    } catch (error) {
      report(error, channel, orgId, signal);
    }
  }

  /** A copy, so a subscriber that unsubscribes while receiving changes nothing mid-loop. */
  function deliverTo(channel: Channel, orgId: string, signal: RealtimeSignal) {
    const subscriptions = channels[channel].get(orgId);
    if (!subscriptions) return;
    for (const subscription of [...subscriptions]) {
      deliver(subscription, channel, orgId, signal);
    }
  }

  function deliverToAll(signal: RealtimeSignal) {
    for (const channel of ['admin', 'public'] as const) {
      for (const orgId of [...channels[channel].keys()]) {
        deliverTo(channel, orgId, signal);
      }
    }
  }

  function subscribe(channel: Channel, orgId: string, fn: RealtimeSubscriber) {
    const subscription: Subscription = { fn };
    if (closed) {
      deliver(subscription, channel, orgId, { kind: 'closed' });
      return () => {};
    }

    const byOrg = channels[channel];
    let subscriptions = byOrg.get(orgId);
    if (!subscriptions) {
      subscriptions = new Set();
      byOrg.set(orgId, subscriptions);
    }
    subscriptions.add(subscription);

    const own = subscriptions;
    return () => {
      if (!own.delete(subscription)) return;
      // An organization with no subscribers left keeps no entry.
      if (own.size === 0 && byOrg.get(orgId) === own) byOrg.delete(orgId);
    };
  }

  return {
    subscribePublic: (orgId, fn) => subscribe('public', orgId, fn),
    subscribeAdmin: (orgId, fn) => subscribe('admin', orgId, fn),

    publish(event) {
      if (closed) return;
      const signal: RealtimeSignal = { kind: 'event', event };
      deliverTo('admin', event.orgId, signal);
      if (isPublicEvent(event.eventName)) {
        deliverTo('public', event.orgId, signal);
      }
    },

    resync() {
      if (closed) return;
      deliverToAll({ kind: 'resync' });
    },

    close() {
      if (closed) return;
      closed = true;
      deliverToAll({ kind: 'closed' });
      channels.admin.clear();
      channels.public.clear();
    },
  };
}
