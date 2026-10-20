import type { Sql } from 'postgres';
import { assertValidBetterAuthOrgId } from '@/shared/db/tenant-transaction';
import {
  BRIDGED_EVENT_NAMES,
  NOTIFY_CHANNEL,
  type RealtimeEvent,
} from '@/shared/realtime/realtime-event';
import type {
  RealtimeHub,
  RealtimeLogger,
} from '@/shared/realtime/realtime-hub';

/**
 * The api's `LISTEN` on `watchdog_events` (story 4.4, ARCHITECTURE.md 5.4).
 *
 * Every notification is validated before the hub sees it. Anything on the
 * channel can be sent by any session with `pg_notify`, so what arrives is
 * input, not a promise kept by the bridge: one that is not JSON, is another
 * version, names an event outside the bridged set or carries an invalid
 * organization id is dropped with a `warn`, and the listener keeps going.
 *
 * postgres.js re-listens by itself after its connection is lost, retrying
 * until it succeeds, and calls `onlisten` after each success. The first call
 * is the initial listen; every later one is a re-listen, after which every
 * subscriber is told to `resync`, since what was sent while it was down is
 * gone (ARCHITECTURE.md 5.1).
 *
 * Imports `tenant-transaction.ts`, and through it the global connection, so
 * this file runs only in the integration suite.
 */

const BRIDGED: ReadonlySet<string> = new Set(BRIDGED_EVENT_NAMES);

/** How much of a dropped payload a `warn` repeats. NOTIFY allows ~8 KB. */
const LOGGED_PAYLOAD_LENGTH = 256;

export type ParsedNotification =
  | { ok: true; event: RealtimeEvent }
  | { ok: false; reason: string };

export function parseNotification(raw: string): ParsedNotification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not a JSON object' };
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== 1) {
    return { ok: false, reason: 'unsupported version' };
  }
  if (
    typeof candidate.eventName !== 'string' ||
    !BRIDGED.has(candidate.eventName)
  ) {
    return { ok: false, reason: 'not a bridged event' };
  }
  try {
    assertValidBetterAuthOrgId(candidate.orgId);
  } catch {
    return { ok: false, reason: 'invalid orgId' };
  }
  const { aggregateType, aggregateId, occurredAt } = candidate;
  if (
    typeof aggregateType !== 'string' ||
    typeof aggregateId !== 'string' ||
    typeof occurredAt !== 'string'
  ) {
    return { ok: false, reason: 'missing a field' };
  }

  // Rebuilt rather than passed through, so nothing beyond the six fields
  // reaches a subscriber.
  return {
    ok: true,
    event: {
      eventName: candidate.eventName,
      orgId: candidate.orgId,
      aggregateType,
      aggregateId,
      occurredAt,
      version: 1,
    },
  };
}

export type NotifyListener = {
  /** The backend pid of the initial listen. A re-listen gets a new one. */
  pid: number;
  /** Unlistens, then ends the client the listener was given. */
  close(): Promise<void>;
};

export async function startNotifyListener({
  sql,
  hub,
  log,
}: {
  /** A client of the listener's own: `close` ends it. */
  sql: Pick<Sql, 'listen' | 'end'>;
  hub: RealtimeHub;
  log: RealtimeLogger;
}): Promise<NotifyListener> {
  let listens = 0;

  function onNotify(raw: string) {
    // postgres.js calls this while parsing the connection's input, so nothing
    // may escape it.
    try {
      const parsed = parseNotification(raw);
      if (!parsed.ok) {
        log.warn(
          {
            channel: NOTIFY_CHANNEL,
            reason: parsed.reason,
            payload: raw.slice(0, LOGGED_PAYLOAD_LENGTH),
          },
          'Dropped a notification',
        );
        return;
      }
      hub.publish(parsed.event);
    } catch (error) {
      log.error({ err: error, channel: NOTIFY_CHANNEL }, 'Notification failed');
    }
  }

  function onListen() {
    listens += 1;
    if (listens === 1) return;
    log.warn(
      { channel: NOTIFY_CHANNEL, listens },
      'Re-listened after the connection was lost; every subscriber resyncs',
    );
    hub.resync();
  }

  let listening: Awaited<ReturnType<Sql['listen']>>;
  try {
    listening = await sql.listen(NOTIFY_CHANNEL, onNotify, onListen);
  } catch (error) {
    // Ended, or postgres.js would keep re-listening in the background and
    // hold the process open after the caller has given up on it.
    await sql.end({ timeout: 0 }).catch(() => undefined);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    pid: listening.state.pid,
    close() {
      closing ??= (async () => {
        // After a re-listen this unlistens nothing: postgres.js registers the
        // re-listen under a new handle. Ending the client is what stops it.
        try {
          await listening.unlisten();
        } catch (error) {
          log.warn(
            { err: error, channel: NOTIFY_CHANNEL },
            'Unlisten failed; ending the connection anyway',
          );
        }
        await sql.end({ timeout: 5 });
      })();
      return closing;
    },
  };
}
