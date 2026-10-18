import type { Action, CommandCreator } from '@/shared/cqrs/bus.types';
import {
  incidentConfirmedEvent,
  incidentCreatedEvent,
  incidentDismissedEvent,
  incidentDraftCreatedEvent,
  incidentResolvedEvent,
  incidentStateChangedEvent,
  incidentUpdatedEvent,
  incidentUpdatePostedEvent,
} from '@/shared/events/incident.events';
import {
  maintenanceCompletedEvent,
  maintenanceCreatedEvent,
  maintenanceDeletedEvent,
  maintenanceStartedEvent,
  maintenanceUpdatedEvent,
} from '@/shared/events/maintenance.events';
import {
  monitorRecoveredEvent,
  monitorSslExpiryWarningEvent,
  monitorThresholdBreachedEvent,
  uptimeRollupRefreshedEvent,
} from '@/shared/events/monitor.events';
import {
  serviceArchivedEvent,
  serviceCreatedEvent,
  serviceGroupCreatedEvent,
  serviceGroupDeletedEvent,
  serviceGroupUpdatedEvent,
  serviceManualOverrideClearedEvent,
  serviceManualOverrideSetEvent,
  serviceRestoredEvent,
  serviceStatusChangedEvent,
  serviceUpdatedEvent,
} from '@/shared/events/service.events';

/**
 * What crosses processes when a domain event happens: ARCHITECTURE.md 5.3 and
 * DOMAIN.md's LISTEN/NOTIFY channel sketch.
 *
 * Pure on purpose. It imports no connection, so the unit suite can check the
 * bridged set and the payload without a database, and the bridge that sends
 * it (`notify-bridge.ts`) is the only part that needs one.
 */

export const NOTIFY_CHANNEL = 'watchdog_events';

/**
 * The whole wire payload. A signal, not a copy of the event: a listener
 * re-reads what it needs by `orgId` and aggregate. Nothing else from the
 * event's payload is sent, so no title, name, slug or message reaches a
 * listener this way.
 */
export type RealtimeEvent = {
  eventName: string;
  orgId: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  version: 1;
};

type Aggregate = Pick<RealtimeEvent, 'aggregateType' | 'aggregateId'>;

/**
 * One bridged event. `aggregate` takes the event's payload; it is typed
 * `unknown` here so one list can hold every creator, and each helper below
 * narrows it to its own creator's payload.
 */
export type BridgedEvent = {
  creator: { readonly type: string };
  aggregate: (payload: unknown) => Aggregate;
};

/** The bus names an event `incident/created`; the wire and DOMAIN, `incident.created`. */
export function toWireName(type: string): string {
  return type.replace('/', '.');
}

/** The part of a bus type before the slash: `service_group/deleted` gives `service_group`. */
function prefixOf(creator: { readonly type: string }): string {
  return creator.type.slice(0, creator.type.indexOf('/'));
}

/** An event about the record named by `payload.id`. */
function byId<P extends { id: string }>(
  creator: CommandCreator<P>,
): BridgedEvent {
  const aggregateType = prefixOf(creator);
  return {
    creator,
    aggregate: (payload) => ({
      aggregateType,
      aggregateId: (payload as P).id,
    }),
  };
}

/** A monitor event, whose payload names the monitor `monitorId`. */
function byMonitorId<P extends { monitorId: string }>(
  creator: CommandCreator<P>,
): BridgedEvent {
  const aggregateType = prefixOf(creator);
  return {
    creator,
    aggregate: (payload) => ({
      aggregateType,
      aggregateId: (payload as P).monitorId,
    }),
  };
}

/**
 * Every event DOMAIN.md's catalog bridges ("Yes"), plus the one "Optional"
 * event ARCHITECTURE.md 5.3 bridges, `uptime.rollup_refreshed`. Keyed by the
 * creators rather than by name strings, so a renamed event fails to compile
 * here instead of silently dropping out of the stream.
 */
export const BRIDGED_EVENTS: readonly BridgedEvent[] = [
  byId(serviceStatusChangedEvent),
  byId(serviceCreatedEvent),
  byId(serviceUpdatedEvent),
  byId(serviceArchivedEvent),
  byId(serviceRestoredEvent),
  byId(serviceManualOverrideSetEvent),
  byId(serviceManualOverrideClearedEvent),
  byId(serviceGroupCreatedEvent),
  byId(serviceGroupUpdatedEvent),
  byId(serviceGroupDeletedEvent),
  byId(incidentCreatedEvent),
  byId(incidentDraftCreatedEvent),
  byId(incidentConfirmedEvent),
  byId(incidentUpdatedEvent),
  byId(incidentUpdatePostedEvent),
  byId(incidentStateChangedEvent),
  byId(incidentResolvedEvent),
  byId(incidentDismissedEvent),
  byId(maintenanceCreatedEvent),
  byId(maintenanceUpdatedEvent),
  byId(maintenanceStartedEvent),
  byId(maintenanceCompletedEvent),
  byId(maintenanceDeletedEvent),
  byMonitorId(monitorRecoveredEvent),
  byMonitorId(monitorThresholdBreachedEvent),
  byMonitorId(monitorSslExpiryWarningEvent),
  // A refresh covers the whole organization, so the organization is its
  // aggregate (owner's decision, 2026-10-18).
  {
    creator: uptimeRollupRefreshedEvent,
    aggregate: (payload) => ({
      aggregateType: 'organization',
      aggregateId: (
        payload as ReturnType<typeof uptimeRollupRefreshedEvent>['payload']
      ).orgId,
    }),
  },
];

const BY_TYPE: ReadonlyMap<string, BridgedEvent> = new Map(
  BRIDGED_EVENTS.map((bridged) => [bridged.creator.type, bridged]),
);

/** The bridged set in DOMAIN's dotted form. */
export const BRIDGED_EVENT_NAMES: readonly string[] = BRIDGED_EVENTS.map(
  ({ creator }) => toWireName(creator.type),
);

/**
 * The wire payload for a bridged event.
 *
 * `occurredAt` is when the event was emitted, which `decorateWithMetadata`
 * stamps as `meta.timestamp` before any handler runs. Not the time the
 * notification is sent, and not one invented here: an event without a stamp
 * did not come through the app's bus, and throwing says so.
 */
export function toRealtimeEvent(action: Action<unknown>): RealtimeEvent {
  const bridged = BY_TYPE.get(action.type);
  if (!bridged) {
    throw new Error(`${action.type} is not a bridged event`);
  }

  const timestamp: unknown = action.meta?.timestamp;
  const occurredAt =
    typeof timestamp === 'number' || timestamp instanceof Date
      ? new Date(timestamp)
      : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    throw new Error(`${action.type} has no meta.timestamp to send`);
  }

  const payload = action.payload as { orgId?: unknown };
  if (typeof payload?.orgId !== 'string' || payload.orgId === '') {
    throw new Error(`${action.type} names no orgId`);
  }

  const { aggregateType, aggregateId } = bridged.aggregate(payload);
  return {
    eventName: toWireName(action.type),
    orgId: payload.orgId,
    aggregateType,
    aggregateId,
    occurredAt: occurredAt.toISOString(),
    version: 1,
  };
}
