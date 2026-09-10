import type {
  IncidentEntity,
  UpdateIncidentProps,
} from '@/modules/incident/domain/incident.domain';
import type {
  IncidentImpact,
  IncidentStatus,
} from '@/modules/incident/domain/incident.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

export interface IncidentRepository {
  /** Writes the incident and its per-service impact in one transaction. */
  insert(tx: TenantTransaction, incident: IncidentEntity): Promise<void>;
  findById(
    tx: TenantTransaction,
    id: string,
  ): Promise<IncidentEntity | undefined>;
  /** Writes a validated status. `resolvedAt` is set only when landing there. */
  updateStatus(
    tx: TenantTransaction,
    id: string,
    status: IncidentStatus,
  ): Promise<IncidentEntity | undefined>;
  /** Edits that carry no status change. */
  updateDetails(
    tx: TenantTransaction,
    id: string,
    patch: UpdateIncidentProps,
  ): Promise<IncidentEntity | undefined>;
  replaceAffectedServices(
    tx: TenantTransaction,
    incident: IncidentEntity,
    affected: { serviceId: string; impact: IncidentImpact }[],
  ): Promise<void>;
}
