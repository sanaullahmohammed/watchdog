import { incidentActionCreator } from '@/modules/incident';
import {
  assertTransition,
  resolutionEventName,
} from '@/modules/incident/domain/incident.state-machine';
import type { IncidentStatus } from '@/modules/incident/domain/incident.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  incidentDismissedEvent,
  incidentResolvedEvent,
  incidentStateChangedEvent,
} from '@/shared/events/incident.events';
import { NotFoundException } from '@/shared/exceptions';

export type TransitionIncidentCommandResult = Promise<string>;

export const transitionIncidentCommand = incidentActionCreator<{
  orgId: string;
  id: string;
  status: IncidentStatus;
}>('transition');

export default function makeTransitionIncident({
  incidentRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof transitionIncidentCommand
    >): TransitionIncidentCommandResult {
      const { orgId, id, status } = payload;

      const { from, incident } = await withTenantTransaction(
        orgId,
        async (tx) => {
          const current = await incidentRepository.findById(tx, id);
          if (!current) {
            throw new NotFoundException(`Incident ${id} not found`);
          }

          // Legality is decided by the state machine, not here, and it throws
          // before anything is written. Reading and writing inside one
          // transaction means the status cannot move underneath the check.
          assertTransition(current.status, status);

          const moved = await incidentRepository.updateStatus(tx, id, status);
          if (!moved) {
            throw new NotFoundException(`Incident ${id} not found`);
          }
          return { from: current.status, incident: moved };
        },
      );

      eventBus.emit(
        incidentStateChangedEvent({
          id: incident.id,
          orgId: incident.orgId,
          from,
          to: incident.status,
        }),
      );

      if (incident.status === 'resolved') {
        // A dismissed draft and a resolved incident both land on `resolved`;
        // only one of them is something customers were ever told about.
        const announcement =
          resolutionEventName(from) === 'incident.dismissed'
            ? incidentDismissedEvent
            : incidentResolvedEvent;

        eventBus.emit(announcement({ id: incident.id, orgId: incident.orgId }));
      }

      return incident.id;
    },
    init() {
      commandBus.register(transitionIncidentCommand.type, this.handler);
    },
  };
}
