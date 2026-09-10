import type {
  MaintenanceEntity,
  MaintenanceStatus,
  UpdateMaintenanceProps,
} from '@/modules/maintenance/domain/maintenance.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

export interface ListMaintenanceFilter {
  status?: MaintenanceStatus;
}

export interface MaintenanceRepository {
  list(
    tx: TenantTransaction,
    filter: ListMaintenanceFilter,
  ): Promise<MaintenanceEntity[]>;
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
