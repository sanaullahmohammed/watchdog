import type { JSONValue } from 'postgres';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import type { CheckErrorCode, CheckOutcome } from '../checks/check-outcome';

export interface CheckResultRow {
  orgId: string;
  monitorId: string;
  serviceId: string;
  checkedAt: Date;
  status: CheckOutcome['status'];
  latencyMs: number | null;
  errorCode: CheckErrorCode | null;
  errorMessage: string | null;
  metadata: object;
}

/**
 * Tenant-scoped and append-only: there is no update or delete, and the
 * migration revokes both from `watchdog_app`.
 */
export default function checkResultRepository() {
  return {
    async append(tx: TenantTransaction, row: CheckResultRow) {
      const rows = await tx.sql<{ id: string }[]>`
        insert into check_results (
          org_id, monitor_id, service_id, checked_at, status, latency_ms,
          error_code, error_message, metadata
        ) values (
          ${row.orgId}, ${row.monitorId}, ${row.serviceId}, ${row.checkedAt},
          ${row.status}, ${row.latencyMs}, ${row.errorCode},
          ${row.errorMessage}, ${tx.sql.json(row.metadata as JSONValue)}
        )
        returning id
      `;
      return rows[0].id;
    },
  };
}
