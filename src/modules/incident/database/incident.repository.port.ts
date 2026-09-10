import type { IncidentEntity } from '@/modules/incident/domain/incident.domain';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

export interface IncidentRepository {
  /** Writes the incident and its per-service impact in one transaction. */
  insert(tx: TenantTransaction, incident: IncidentEntity): Promise<void>;
  findById(
    tx: TenantTransaction,
    id: string,
  ): Promise<IncidentEntity | undefined>;
}
