import { monitoringActionCreator } from '@/modules/monitoring';
import type { MonitorEntity } from '@/modules/monitoring/domain/monitor.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { assertUuid } from '@/shared/validation/typebox-guard';

export type ListMonitorsQueryResult = Promise<MonitorEntity[]>;

export const listMonitorsQuery = monitoringActionCreator<{
  orgId: string;
  serviceId: string;
}>('list');

export default function makeListMonitors({
  monitorRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof listMonitorsQuery>): ListMonitorsQueryResult {
      assertUuid(payload.serviceId, 'serviceId');

      // No lookup of the service: that would read `services` from this module.
      // A service that is unknown, or in another organization, simply has no
      // monitors visible under RLS, so the answer is an empty list.
      return withTenantTransaction(payload.orgId, (tx) =>
        monitorRepository.listByService(tx, payload.serviceId),
      );
    },
    init() {
      queryBus.register(listMonitorsQuery.type, this.handler);
    },
  };
}
