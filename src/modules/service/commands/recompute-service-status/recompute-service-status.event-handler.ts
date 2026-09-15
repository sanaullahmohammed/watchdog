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
      // Returned rather than swallowed: the bus tracks the promise, so a
      // shutdown can wait for this recomputation, and contains a rejection
      // either way. The catch here only adds the organization to the log line.
      return recompute(event.payload.orgId).catch((error: unknown) => {
        logger.error(
          { err: error, event: event.type, orgId: event.payload.orgId },
          'service status recomputation failed',
        );
      });
    },

    init() {
      for (const trigger of RECOMPUTE_TRIGGERS) {
        eventBus.on(trigger.type, this.handler);
      }
    },
  };
}
