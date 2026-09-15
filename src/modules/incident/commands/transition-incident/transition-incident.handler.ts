import { incidentActionCreator } from '@/modules/incident';
import {
  assertTransition,
  resolutionEventName,
} from '@/modules/incident/domain/incident.state-machine';
import type { IncidentStatus } from '@/modules/incident/domain/incident.types';
import { timelineEntryMessage } from '@/modules/incident/domain/incident-timeline';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  incidentConfirmedEvent,
  incidentDismissedEvent,
  incidentResolvedEvent,
  incidentStateChangedEvent,
  incidentUpdatePostedEvent,
} from '@/shared/events/incident.events';
import { NotFoundException } from '@/shared/exceptions';
import { assertNoNullFields } from '@/shared/validation/input';

export type TransitionIncidentCommandResult = Promise<string>;

export const transitionIncidentCommand = incidentActionCreator<{
  orgId: string;
  id: string;
  status: IncidentStatus;
  /** Who made the move; recorded on the timeline entry it appends. */
  userId: string | null;
  /** The timeline entry's text. A default is written when absent. */
  message?: string | null;
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
      const { orgId, id, status, userId, message } = payload;
      // GraphQL cannot express "optional but never null", a format, or a
      // minimum length, so these run here, where both surfaces arrive.
      assertNoNullFields(payload, { nullable: ['userId', 'message'] });

      const { from, incident, updateId } = await withTenantTransaction(
        orgId,
        async (tx) => {
          // Locked until commit. One transaction alone does not serialize:
          // under READ COMMITTED two transitions could both read the same
          // status, both pass the check below, and the second would overwrite
          // the first, reopening a resolved incident. With the lock, the second
          // waits, reads the committed status, and is judged against that.
          // Epic 2 retrospective, R-2.
          const current = await incidentRepository.findById(tx, id, {
            lock: 'update',
          });
          if (!current) {
            throw new NotFoundException(`Incident ${id} not found`);
          }

          // Legality is decided by the state machine, not here, and it throws
          // before anything is written.
          assertTransition(current.status, status);

          const moved = await incidentRepository.updateStatus(tx, id, status);
          if (!moved) {
            throw new NotFoundException(`Incident ${id} not found`);
          }

          // DOMAIN.md: every transition appends a timeline entry in the same
          // transaction, so the timeline cannot disagree with the status.
          const updateId = await incidentRepository.appendUpdate(tx, {
            orgId,
            incidentId: id,
            status: moved.status,
            message: timelineEntryMessage(message, current.status, status),
            createdByUserId: userId,
          });

          return { from: current.status, incident: moved, updateId };
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

      if (from !== 'draft') {
        // The public announcement of this move. incident.state_changed is
        // admin-only, so a move to identified or monitoring would otherwise
        // reach no public subscriber at all. A move out of draft is not a
        // public lifecycle transition: confirming and dismissing announce
        // themselves below. DOMAIN.md, IncidentUpdate; retrospective R-5.
        eventBus.emit(
          incidentUpdatePostedEvent({
            id: incident.id,
            orgId: incident.orgId,
            updateId,
          }),
        );
      }

      if (from === 'draft' && incident.status === 'investigating') {
        // The public counterpart of dismissal: DOMAIN's catalog announces a
        // confirmed draft, and status recomputation listens for it.
        eventBus.emit(
          incidentConfirmedEvent({ id: incident.id, orgId: incident.orgId }),
        );
      }

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
