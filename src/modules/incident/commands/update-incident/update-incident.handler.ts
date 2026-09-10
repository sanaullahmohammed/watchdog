import { incidentActionCreator } from '@/modules/incident';
import type { UpdateIncidentProps } from '@/modules/incident/domain/incident.domain';
import type { IncidentImpact } from '@/modules/incident/domain/incident.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentUpdatedEvent } from '@/shared/events/incident.events';
import { NotFoundException } from '@/shared/exceptions';

export type UpdateIncidentCommandResult = Promise<string>;

export type UpdateIncidentCommandPayload = UpdateIncidentProps & {
  orgId: string;
  id: string;
  affectedServices?: { serviceId: string; impact: IncidentImpact }[];
};

export const updateIncidentCommand =
  incidentActionCreator<UpdateIncidentCommandPayload>('update');

export default function makeUpdateIncident({
  incidentRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof updateIncidentCommand>): UpdateIncidentCommandResult {
      const { orgId, id, affectedServices, ...patch } = payload;

      const updated = await withTenantTransaction(orgId, async (tx) => {
        const incident = await incidentRepository.updateDetails(tx, id, patch);
        if (!incident) {
          throw new NotFoundException(`Incident ${id} not found`);
        }

        if (affectedServices !== undefined) {
          await incidentRepository.replaceAffectedServices(
            tx,
            incident,
            affectedServices,
          );
        }

        return incident;
      });

      // Distinct from incident.state_changed on purpose. Retitling an incident
      // and advancing its lifecycle are different things to anyone listening,
      // and only one of them is a change customers are told about.
      eventBus.emit(
        incidentUpdatedEvent({ id: updated.id, orgId: updated.orgId }),
      );

      return updated.id;
    },
    init() {
      commandBus.register(updateIncidentCommand.type, this.handler);
    },
  };
}
