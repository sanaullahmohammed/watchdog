import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sql from '@/shared/db/postgres';
import {
  NOTIFY_CHANNEL,
  type RealtimeEvent,
} from '@/shared/realtime/realtime-event';
import type {
  RealtimeHub,
  RealtimeSignal,
} from '@/shared/realtime/realtime-hub';

/**
 * Hears what the NOTIFY bridge sends on `watchdog_events` for one
 * organization, either straight off the channel (`listenForOrg`, story 4.3) or
 * through a listening app's hub (`subscribeForOrg`, story 4.4). Reused by 4.9.
 *
 * Integration files run concurrently against one database and every app
 * bridges, so a listener sees every file's notifications. Filtering by the
 * test's own `orgId` keeps it to its own.
 *
 * `settle` is how a test knows nothing more is coming without sleeping. It
 * drains the app's bus, so every bridged `pg_notify` has been sent, then sends
 * a sentinel for the same organization and waits for it. Postgres delivers
 * notifications from different transactions in commit order, so once the
 * sentinel arrives, everything sent before it has arrived too. A negative
 * assertion is then as quick as a positive one.
 *
 * The sentinel is a real bridged, admin-only event, `uptime.rollup_refreshed`,
 * marked by its `aggregateType`. A listening api accepts it instead of
 * dropping it with a `warn`, and it never reaches the public path, so no
 * public page is recomposed for one (4.6).
 */

const SENTINEL_EVENT_NAME = 'uptime.rollup_refreshed';
const SENTINEL_AGGREGATE_TYPE = 'test.sentinel';
const SETTLE_TIMEOUT_MS = 5_000;

function isSentinel(event: RealtimeEvent): boolean {
  return event.aggregateType === SENTINEL_AGGREGATE_TYPE;
}

/** Sends any text on the channel, as a misbehaving session could. */
export async function notifyRaw(text: string): Promise<void> {
  await sql`select pg_notify(${NOTIFY_CHANNEL}, ${text})`;
}

/**
 * Sends a sentinel for `orgId` and resolves once `sentinels` hears it. The
 * caller's listener resolves the entry keyed by the sentinel's `aggregateId`.
 */
async function sendSentinel(
  orgId: string,
  sentinels: Map<string, () => void>,
  app: FastifyInstance | undefined,
): Promise<void> {
  if (app) await app.eventBus.drain();

  const id = randomUUID();
  let timer: NodeJS.Timeout | undefined;
  const arrived = new Promise<void>((resolve, reject) => {
    sentinels.set(id, resolve);
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `no sentinel on ${NOTIFY_CHANNEL} for ${orgId} within ${SETTLE_TIMEOUT_MS}ms`,
          ),
        ),
      SETTLE_TIMEOUT_MS,
    );
  });

  const sentinel: RealtimeEvent = {
    eventName: SENTINEL_EVENT_NAME,
    orgId,
    aggregateType: SENTINEL_AGGREGATE_TYPE,
    aggregateId: id,
    occurredAt: new Date().toISOString(),
    version: 1,
  };
  try {
    // Awaited together, so a timeout while the send is still pending is
    // handled rather than left as an unhandled rejection.
    await Promise.all([notifyRaw(JSON.stringify(sentinel)), arrived]);
  } finally {
    clearTimeout(timer);
    sentinels.delete(id);
  }
}

export async function listenForOrg(orgId: string) {
  const received: RealtimeEvent[] = [];
  const sentinels = new Map<string, () => void>();

  const { unlisten } = await sql.listen(NOTIFY_CHANNEL, (raw) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      // Another file's deliberately malformed notification.
      return;
    }
    if (event?.orgId !== orgId) return;
    if (isSentinel(event)) {
      sentinels.get(event.aggregateId)?.();
      return;
    }
    received.push(event);
  });

  /**
   * Resolves once everything the bridge sent for this organization so far has
   * arrived. Pass the app whose bus did the emitting, so its bridged sends are
   * drained first. Omit it only when that bus has already been drained, as by
   * `app.close()` in the closing case. That case shows a notification emitted
   * before close still arrives; the drain itself is proven in
   * src/shared/cqrs/event-bus.integration.test.ts.
   */
  function settle(app?: FastifyInstance): Promise<void> {
    return sendSentinel(orgId, sentinels, app);
  }

  return { received, settle, close: unlisten };
}

/**
 * Subscribes to one organization on a listening app's hub, both channels.
 * `admin` and `public` hold every signal each received, sentinels left out.
 *
 * `settle` waits for the sentinel on the admin channel. The hub delivers each
 * notification synchronously and in order, so by then every earlier public
 * delivery has happened too. Pass the app whose bus did the emitting, which
 * need not be the listening one.
 */
export function subscribeForOrg(hub: RealtimeHub, orgId: string) {
  const admin: RealtimeSignal[] = [];
  const publicSignals: RealtimeSignal[] = [];
  const sentinels = new Map<string, () => void>();

  const offAdmin = hub.subscribeAdmin(orgId, (signal) => {
    if (signal.kind === 'event' && isSentinel(signal.event)) {
      sentinels.get(signal.event.aggregateId)?.();
      return;
    }
    admin.push(signal);
  });
  const offPublic = hub.subscribePublic(orgId, (signal) => {
    if (signal.kind === 'event' && isSentinel(signal.event)) return;
    publicSignals.push(signal);
  });

  return {
    admin,
    public: publicSignals,
    settle: (app?: FastifyInstance) => sendSentinel(orgId, sentinels, app),
    close() {
      offAdmin();
      offPublic();
    },
  };
}
