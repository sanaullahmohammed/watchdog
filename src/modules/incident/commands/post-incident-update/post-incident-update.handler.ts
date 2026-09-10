import { incidentActionCreator } from '@/modules/incident';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentUpdatePostedEvent } from '@/shared/events/incident.events';
import { NotFoundException } from '@/shared/exceptions';

export type PostIncidentUpdateCommandResult = Promise<string>;

export const postIncidentUpdateCommand = incidentActionCreator<{
  orgId: string;
  incidentId: string;
  message: string;
  userId: string | null;
}>('update_posted');

export default function makePostIncidentUpdate({
  incidentRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof postIncidentUpdateCommand
    >): PostIncidentUpdateCommandResult {
      const { orgId, incidentId, message, userId } = payload;

      const updateId = await withTenantTransaction(orgId, async (tx) => {
        const incident = await incidentRepository.findById(tx, incidentId);
        if (!incident) {
          throw new NotFoundException(`Incident ${incidentId} not found`);
        }

        // The status is taken from the incident inside this transaction, not
        // from the caller, so the timeline reads correctly after the incident
        // moves on and cannot be made to claim a status it never held.
        return incidentRepository.appendUpdate(tx, {
          orgId,
          incidentId,
          status: incident.status,
          message,
          createdByUserId: userId,
        });
      });

      eventBus.emit(
        incidentUpdatePostedEvent({ id: incidentId, orgId, updateId }),
      );

      return updateId;
    },
    init() {
      commandBus.register(postIncidentUpdateCommand.type, this.handler);
    },
  };
}
