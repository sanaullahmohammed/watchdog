import { monitoringActionCreator } from '@/modules/monitoring';
import type { MonitorEntity } from '@/modules/monitoring/domain/monitor.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type ListMonitorsAtThresholdQueryResult = Promise<MonitorEntity[]>;

/** System query for the worker: no route, resolver or schema. */
export const listMonitorsAtThresholdQuery = monitoringActionCreator<{
  orgId: string;
}>('list_at_threshold');

export default function makeListMonitorsAtThreshold({
  monitorRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof listMonitorsAtThresholdQuery
    >): ListMonitorsAtThresholdQueryResult {
      return withTenantTransaction(payload.orgId, (tx) =>
        monitorRepository.listAtThreshold(tx),
      );
    },
    init() {
      queryBus.register(listMonitorsAtThresholdQuery.type, this.handler);
    },
  };
}
