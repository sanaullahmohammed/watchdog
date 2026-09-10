import { incidentActionCreator } from '@/modules/incident';
import type { CreateIncidentProps } from '@/modules/incident/domain/incident.domain';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { incidentCreatedEvent } from '@/shared/events/incident.events';

export type CreateIncidentCommandResult = Promise<string>;

export type CreateIncidentCommandPayload = CreateIncidentProps & {
  orgId: string;
  userId: string | null;
};

export const createIncidentCommand =
  incidentActionCreator<CreateIncidentCommandPayload>('create');

export default function makeCreateIncident({
  incidentRepository,
  incidentDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof createIncidentCommand>): CreateIncidentCommandResult {
      const { orgId, userId, ...props } = payload;
      const incident = incidentDomain.declareIncident(orgId, userId, props);

      await withTenantTransaction(orgId, (tx) =>
        incidentRepository.insert(tx, incident),
      );

      eventBus.emit(
        incidentCreatedEvent({ id: incident.id, orgId: incident.orgId }),
      );

      return incident.id;
    },
    init() {
      commandBus.register(createIncidentCommand.type, this.handler);
    },
  };
}
