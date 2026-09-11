import { resolveServiceStatus } from '@/modules/service/domain/effective-status';
import type { ServiceStatus } from '@/modules/service/domain/service.types';
import type { Action } from '@/shared/cqrs/bus.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  incidentConfirmedEvent,
  incidentCreatedEvent,
  incidentDismissedEvent,
  incidentResolvedEvent,
  incidentStateChangedEvent,
  incidentUpdatedEvent,
} from '@/shared/events/incident.events';
import {
  maintenanceCompletedEvent,
  maintenanceDeletedEvent,
  maintenanceStartedEvent,
  maintenanceUpdatedEvent,
} from '@/shared/events/maintenance.events';
import {
  serviceManualOverrideClearedEvent,
  serviceManualOverrideSetEvent,
  serviceRestoredEvent,
  serviceStatusChangedEvent,
} from '@/shared/events/service.events';

/**
 * Every event that can move a service's effective status, from DOMAIN.md's
 * Status recomputation section. Reached through `src/shared/events/`: the
 * incident and maintenance modules are never imported, only their contracts.
 *
 * `incident.updated`, `maintenance.updated` and `service.restored` are there
 * because an edit can rewrite an active incident's or an in-progress window's
 * affected services, and a restored service returns with the value it had
 * when it was archived. Leaving any of them out lets status drift silently.
 */
export const RECOMPUTE_TRIGGERS = [
  incidentCreatedEvent,
  incidentConfirmedEvent,
  incidentStateChangedEvent,
  incidentResolvedEvent,
  incidentDismissedEvent,
  incidentUpdatedEvent,
  maintenanceStartedEvent,
  maintenanceCompletedEvent,
  maintenanceDeletedEvent,
  maintenanceUpdatedEvent,
  serviceManualOverrideSetEvent,
  serviceManualOverrideClearedEvent,
  serviceRestoredEvent,
] as const;

export type ServiceStatusChange = {
  id: string;
  orgId: string;
  slug: string;
  from: ServiceStatus;
  to: ServiceStatus;
};

export default function makeRecomputeServiceStatus({
  serviceStatusRepository,
  eventBus,
  logger,
}: Dependencies) {
  const inFlight = new Set<Promise<void>>();

  /**
   * Recomputes every live service in one organization, under that
   * organization's tenant context.
   *
   * Every service rather than the ones the triggering event names, because by
   * the time this runs the link rows may be gone: an edit can drop a service
   * from an incident, and deleting a window cascades its links away. A status
   * page holds tens of services, so the whole set is one cheap read, and
   * services whose answer has not moved produce no write and no event.
   */
  async function recompute(orgId: string): Promise<ServiceStatusChange[]> {
    const changes = await withTenantTransaction(orgId, async (tx) => {
      const services = await serviceStatusRepository.lockLiveServiceInputs(tx);
      const moved: ServiceStatusChange[] = [];

      for (const service of services) {
        const to = resolveServiceStatus({
          manualOverride: service.manualOverride,
          activeIncidentImpacts: service.activeIncidentImpacts,
          hasActiveMaintenance: service.hasActiveMaintenance,
          // Monitor-derived state arrives with Epic 5.
          monitorState: null,
        });
        if (to === service.lastKnownStatus) continue;

        await serviceStatusRepository.writeLastKnownStatus(tx, service.id, to);
        moved.push({
          id: service.id,
          orgId: service.orgId,
          slug: service.slug,
          from: service.lastKnownStatus,
          to,
        });
      }

      return moved;
    });

    // After commit, like every other emitter: a listener must never hear about
    // a change that then rolled back.
    for (const change of changes) {
      eventBus.emit(serviceStatusChangedEvent(change));
    }

    return changes;
  }

  return {
    recompute,

    handler(event: Action<{ orgId: string }>) {
      // The event bus does not await handlers. A rejection escaping here would
      // be unhandled and take the process down with it, so one organization's
      // failure is logged and contained, as in the worker's tenant loop.
      const run = recompute(event.payload.orgId).then(
        () => undefined,
        (error: unknown) => {
          logger.error(
            { err: error, event: event.type, orgId: event.payload.orgId },
            'service status recomputation failed',
          );
        },
      );
      inFlight.add(run);
      void run.finally(() => inFlight.delete(run));
    },

    /** Resolves once every recomputation started so far has settled. */
    async drain() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },

    init() {
      for (const trigger of RECOMPUTE_TRIGGERS) {
        eventBus.on(trigger.type, this.handler);
      }
    },
  };
}
