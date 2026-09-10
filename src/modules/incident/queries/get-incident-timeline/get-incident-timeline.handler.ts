import { incidentActionCreator } from '@/modules/incident';
import type { IncidentStatus } from '@/modules/incident/domain/incident.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { NotFoundException } from '@/shared/exceptions';

export type IncidentTimelineEntry = {
  id: string;
  status: IncidentStatus;
  message: string;
  createdAt: Date;
};

export type GetIncidentTimelineQueryResult = Promise<IncidentTimelineEntry[]>;

export const getIncidentTimelineQuery = incidentActionCreator<{
  orgId: string;
  incidentId: string;
}>('timeline');

export default function makeGetIncidentTimeline({
  incidentRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof getIncidentTimelineQuery
    >): GetIncidentTimelineQueryResult {
      const { orgId, incidentId } = payload;

      return withTenantTransaction(orgId, async (tx) => {
        // An incident in another organization is invisible under RLS, so this
        // is a 404 rather than an empty timeline. The two are different
        // answers and only one of them is honest.
        const incident = await incidentRepository.findById(tx, incidentId);
        if (!incident) {
          throw new NotFoundException(`Incident ${incidentId} not found`);
        }

        return incidentRepository.timeline(tx, incidentId);
      });
    },
    init() {
      queryBus.register(getIncidentTimelineQuery.type, this.handler);
    },
  };
}
