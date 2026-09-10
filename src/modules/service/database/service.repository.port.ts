import type {
  ServiceEntity,
  UpdateServiceProps,
} from '@/modules/service/domain/service.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * Tenant-scoped repository contract.
 *
 * Deliberately not `RepositoryPort<T>`: that base closes over the global
 * connection, which has no `app.current_org_id` set and would therefore see
 * nothing. Every method here takes the transaction instead, so a caller cannot
 * reach tenant data without having gone through `withTenantTransaction`.
 */
export interface ServiceRepository {
  insert(tx: TenantTransaction, service: ServiceEntity): Promise<void>;
  /** Returns the updated entity, or undefined when the row is out of scope. */
  update(
    tx: TenantTransaction,
    id: string,
    patch: UpdateServiceProps,
  ): Promise<ServiceEntity | undefined>;
  findById(
    tx: TenantTransaction,
    id: string,
  ): Promise<ServiceEntity | undefined>;
  /**
   * Sets `archived_at` only if it is currently null, so the caller can tell an
   * archive that happened from one that was already done. `undefined` means
   * either already archived or out of scope; `findById` separates the two.
   */
  archive(
    tx: TenantTransaction,
    id: string,
  ): Promise<ServiceEntity | undefined>;
  /** Clears `archived_at` only if it is currently set. */
  restore(
    tx: TenantTransaction,
    id: string,
  ): Promise<ServiceEntity | undefined>;
}
