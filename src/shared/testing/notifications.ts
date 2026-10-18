import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sql from '@/shared/db/postgres';
import {
  NOTIFY_CHANNEL,
  type RealtimeEvent,
} from '@/shared/realtime/realtime-event';

/**
 * Hears what the NOTIFY bridge sends on `watchdog_events` for one
 * organization (story 4.3; reused by 4.4 and 4.9).
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
 */

const SENTINEL = 'test.sentinel';
const SETTLE_TIMEOUT_MS = 5_000;

export async function listenForOrg(orgId: string) {
  const received: RealtimeEvent[] = [];
  const sentinels = new Map<string, () => void>();

  const { unlisten } = await sql.listen(NOTIFY_CHANNEL, (raw) => {
    const event = JSON.parse(raw) as RealtimeEvent;
    if (event.orgId !== orgId) return;
    if (event.eventName === SENTINEL) {
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
  async function settle(app?: FastifyInstance): Promise<void> {
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
      eventName: SENTINEL,
      orgId,
      aggregateType: 'test',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      version: 1,
    };
    try {
      // Awaited together, so a timeout while the send is still pending is
      // handled rather than left as an unhandled rejection.
      await Promise.all([
        sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(sentinel)})`,
        arrived,
      ]);
    } finally {
      clearTimeout(timer);
      sentinels.delete(id);
    }
  }

  return { received, settle, close: unlisten };
}
