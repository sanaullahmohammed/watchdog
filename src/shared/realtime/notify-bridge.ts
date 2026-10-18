import type { Sql } from 'postgres';
import type { EventBus } from '@/shared/cqrs/bus.types';
import {
  BRIDGED_EVENTS,
  NOTIFY_CHANNEL,
  toRealtimeEvent,
} from '@/shared/realtime/realtime-event';

/**
 * Sends every bridged domain event to `pg_notify` on `watchdog_events`, so a
 * process other than the emitting one can hear it (ARCHITECTURE.md 5.3).
 *
 * One bus handler per bridged event, registered in every app instance: the
 * api, the worker and every test app. Events are emitted after their command
 * commits, so a rolled-back change is never announced, and the notification
 * is its own autocommitted statement on the pool.
 *
 * The handler returns the query rather than awaiting it. The bus tracks that
 * promise, so a refused `pg_notify` reaches `onHandlerError` instead of the
 * emitter, and `app.close()` drains it before the pool ends. `sql` is passed
 * in rather than imported, which keeps `src/shared/cqrs` and the unit suite
 * free of the global connection.
 */
export function registerNotifyBridge(eventBus: EventBus, sql: Sql): void {
  for (const { creator } of BRIDGED_EVENTS) {
    eventBus.on(creator.type, (event) => {
      const payload = toRealtimeEvent(event);
      return sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})`;
    });
  }
}
