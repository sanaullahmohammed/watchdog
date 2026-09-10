import { maintenanceActionCreator } from '@/modules/maintenance';
import type { MaintenanceEntity } from '@/modules/maintenance/domain/maintenance.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { NotFoundException } from '@/shared/exceptions';

export type GetMaintenanceQueryResult = Promise<MaintenanceEntity>;

export const getMaintenanceQuery = maintenanceActionCreator<{
  orgId: string;
  id: string;
}>('get');

export default function makeGetMaintenance({
  maintenanceRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof getMaintenanceQuery>): GetMaintenanceQueryResult {
      const window = await withTenantTransaction(payload.orgId, (tx) =>
        maintenanceRepository.findById(tx, payload.id),
      );

      // A window in another organization is invisible under RLS. Answering 404
      // rather than an empty body keeps "does not exist here" and "exists but
      // is empty" from looking the same.
      if (!window) {
        throw new NotFoundException(`Maintenance ${payload.id} not found`);
      }

      return window;
    },
    init() {
      queryBus.register(getMaintenanceQuery.type, this.handler);
    },
  };
}
