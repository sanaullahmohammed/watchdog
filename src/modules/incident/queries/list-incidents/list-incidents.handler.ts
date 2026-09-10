import { incidentActionCreator } from '@/modules/incident';
import type { ListIncidentsFilter } from '@/modules/incident/database/incident.repository.port';
import type { IncidentEntity } from '@/modules/incident/domain/incident.domain';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type ListIncidentsQueryResult = Promise<IncidentEntity[]>;

export const listIncidentsQuery = incidentActionCreator<
  ListIncidentsFilter & { orgId: string }
>('list');

export default function makeListIncidents({
  incidentRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof listIncidentsQuery>): ListIncidentsQueryResult {
      const { orgId, ...filter } = payload;
      return withTenantTransaction(orgId, (tx) =>
        incidentRepository.list(tx, filter),
      );
    },
    init() {
      queryBus.register(listIncidentsQuery.type, this.handler);
    },
  };
}
