import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * Tenant-scoped and append-only: the migration revokes update and delete from
 * `watchdog_app`, because an edited or deleted marker would warn again.
 */
export default function monitorSslWarningRepository() {
  return {
    /** True only when this call created the marker. */
    async insertIfAbsent(
      tx: TenantTransaction,
      row: {
        orgId: string;
        monitorId: string;
        fingerprint: string;
        expiresAt: Date;
      },
    ) {
      const rows = await tx.sql`
        insert into monitor_ssl_warnings (
          org_id, monitor_id, certificate_fingerprint, certificate_expires_at
        ) values (
          ${row.orgId}, ${row.monitorId}, ${row.fingerprint}, ${row.expiresAt}
        )
        on conflict (org_id, monitor_id, certificate_fingerprint) do nothing
        returning 1
      `;
      return rows.length > 0;
    },
  };
}
