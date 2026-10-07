import { incidentActionCreator } from '@/modules/incident';
import type { IncidentEntity } from '@/modules/incident/domain/incident.domain';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { NotFoundException } from '@/shared/exceptions';
import { assertUuid } from '@/shared/validation/typebox-guard';

export type GetIncidentQueryResult = Promise<IncidentEntity>;

export const getIncidentQuery = incidentActionCreator<{
  orgId: string;
  id: string;
}>('get');

export default function makeGetIncident({
  incidentRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof getIncidentQuery>): GetIncidentQueryResult {
      assertUuid(payload.id, 'id');
      // findById reads the row and then its impacts: one snapshot, so a
      // concurrent edit cannot yield old fields with new services.
      const incident = await withTenantTransaction(
        payload.orgId,
        (tx) => incidentRepository.findById(tx, payload.id),
        { isolation: 'repeatable read', readOnly: true },
      );

      // Another organization's incident is invisible under RLS, so it is a 404
      // exactly like one that never existed. Drafts are returned: this is the
      // admin surface.
      if (!incident) {
        throw new NotFoundException(`Incident ${payload.id} not found`);
      }

      return incident;
    },
    init() {
      queryBus.register(getIncidentQuery.type, this.handler);
    },
  };
}
