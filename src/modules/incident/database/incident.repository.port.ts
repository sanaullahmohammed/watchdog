import type {
  IncidentEntity,
  UpdateIncidentProps,
} from '@/modules/incident/domain/incident.domain';
import type {
  IncidentImpact,
  IncidentStatus,
} from '@/modules/incident/domain/incident.types';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * `draft` is the axis here, as `archived` is for services. A monitor-born
 * draft has never been shown to anyone, so no public-facing read may return
 * it. `includeDrafts` is an admin affordance and, like `includeArchived`, must
 * never reopen a public surface.
 */
export interface ListIncidentsFilter {
  includeDrafts?: boolean;
  publicOnly?: boolean;
  status?: IncidentStatus;
}

export interface IncidentRepository {
  list(
    tx: TenantTransaction,
    filter: ListIncidentsFilter,
  ): Promise<IncidentEntity[]>;
  timeline(
    tx: TenantTransaction,
    incidentId: string,
  ): Promise<
    {
      id: string;
      status: IncidentStatus;
      message: string;
      createdAt: Date;
    }[]
  >;
  /** Writes the incident and its per-service impact in one transaction. */
  insert(tx: TenantTransaction, incident: IncidentEntity): Promise<void>;
  /**
   * `lock` holds a row lock until the transaction ends. Transitions take
   * `update` (FOR NO KEY UPDATE), so two of them cannot both pass the legality
   * check against the same status. Posted updates take `share`, so they record
   * the committed status, never one a transition is about to replace. Neither
   * blocks the `for key share` that foreign-key checks take.
   */
  findById(
    tx: TenantTransaction,
    id: string,
    options?: { lock?: 'update' | 'share' },
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
  /**
   * Appends a timeline entry. There is deliberately no update or delete
   * counterpart: the privilege is revoked at the database, so one here would
   * only fail later and less clearly.
   */
  appendUpdate(
    tx: TenantTransaction,
    entry: {
      orgId: string;
      incidentId: string;
      status: IncidentStatus;
      message: string;
      createdByUserId: string | null;
    },
  ): Promise<string>;
  replaceAffectedServices(
    tx: TenantTransaction,
    incident: IncidentEntity,
    affected: { serviceId: string; impact: IncidentImpact }[],
  ): Promise<void>;
}
