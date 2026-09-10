import type {
  ServiceGroupEntity,
  UpdateServiceGroupProps,
} from '@/modules/service/domain/service-group.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

export interface ServiceGroupRepository {
  insert(tx: TenantTransaction, group: ServiceGroupEntity): Promise<void>;
  update(
    tx: TenantTransaction,
    id: string,
    patch: UpdateServiceGroupProps,
  ): Promise<ServiceGroupEntity | undefined>;
  /** Returns the deleted group, or undefined when it is out of scope. */
  remove(
    tx: TenantTransaction,
    id: string,
  ): Promise<ServiceGroupEntity | undefined>;
}
