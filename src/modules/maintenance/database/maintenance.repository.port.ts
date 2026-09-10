import type {
  MaintenanceEntity,
  UpdateMaintenanceProps,
} from '@/modules/maintenance/domain/maintenance.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

export interface MaintenanceRepository {
  insert(tx: TenantTransaction, window: MaintenanceEntity): Promise<void>;
  update(
    tx: TenantTransaction,
    id: string,
    patch: UpdateMaintenanceProps,
  ): Promise<MaintenanceEntity | undefined>;
  replaceAffectedServices(
    tx: TenantTransaction,
    window: MaintenanceEntity,
    serviceIds: string[],
  ): Promise<void>;
  findById(
    tx: TenantTransaction,
    id: string,
  ): Promise<MaintenanceEntity | undefined>;
}
