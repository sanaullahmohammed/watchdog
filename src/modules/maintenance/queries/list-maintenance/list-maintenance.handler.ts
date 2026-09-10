import { maintenanceActionCreator } from '@/modules/maintenance';
import type { ListMaintenanceFilter } from '@/modules/maintenance/database/maintenance.repository.port';
import type { MaintenanceEntity } from '@/modules/maintenance/domain/maintenance.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type ListMaintenanceQueryResult = Promise<MaintenanceEntity[]>;

export const listMaintenanceQuery = maintenanceActionCreator<
  ListMaintenanceFilter & { orgId: string }
>('list');

export default function makeListMaintenance({
  maintenanceRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof listMaintenanceQuery>): ListMaintenanceQueryResult {
      const { orgId, ...filter } = payload;
      return withTenantTransaction(orgId, (tx) =>
        maintenanceRepository.list(tx, filter),
      );
    },
    init() {
      queryBus.register(listMaintenanceQuery.type, this.handler);
    },
  };
}
