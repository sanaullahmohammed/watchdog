import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * Where the notification pass has read an organization's durable history to.
 * DOMAIN, NotificationCursor.
 *
 * Every position crosses as text, and SQL casts it from `text`: a timestamp
 * keeps its microseconds and a `bigint` its digits. A parameter the server
 * types as `timestamptz`, by `${value}::timestamptz`, is serialized by
 * postgres.js through a JS `Date`, which keeps milliseconds only. A cursor
 * stored that way sits just below the row it read, and reads it again.
 */
export type NotificationCursor = {
  /** The highest `incident_updates.sequence` read; '0' before the first pass. */
  incidentUpdateSequence: string;
  /** The latest maintenance timestamp read; null before the first window. */
  maintenanceReadAt: string | null;
  /** When the last pass read; null before the first pass. */
  readAt: string | null;
};

/** Takes a `TenantTransaction` per call, like every tenant repository. */
export default function notificationCursorRepository() {
  return {
    /**
     * The organization's cursor, created at its starting values if missing,
     * and locked `for update` until the transaction ends, so two passes for
     * one organization run one after the other.
     */
    async lockForPass(tx: TenantTransaction): Promise<NotificationCursor> {
      await tx.sql`
        insert into notification_cursors (org_id)
        values (${tx.orgId})
        on conflict (org_id) do nothing
      `;
      const rows = await tx.sql<
        {
          incident_update_sequence: string;
          maintenance_read_at: string | null;
          read_at: string | null;
        }[]
      >`
        select
          incident_update_sequence::text as incident_update_sequence,
          maintenance_read_at::text as maintenance_read_at,
          read_at::text as read_at
        from notification_cursors
        where org_id = ${tx.orgId}
        for update
      `;
      const row = rows[0];
      if (!row) throw new Error('the notification cursor was not created');
      return {
        incidentUpdateSequence: row.incident_update_sequence,
        maintenanceReadAt: row.maintenance_read_at,
        readAt: row.read_at,
      };
    },

    /**
     * Moves each position to the greatest of its old value and what this
     * pass scanned, so it never moves back; a null leaves it where it is.
     * `read_at` becomes the transaction's `now()`.
     */
    async advance(
      tx: TenantTransaction,
      scanned: {
        incidentUpdateSequence: string | null;
        maintenanceReadAt: string | null;
      },
    ): Promise<void> {
      await tx.sql`
        update notification_cursors
        set incident_update_sequence = greatest(
              incident_update_sequence,
              ${scanned.incidentUpdateSequence}::text::bigint
            ),
            maintenance_read_at = greatest(
              maintenance_read_at,
              ${scanned.maintenanceReadAt}::text::timestamptz
            ),
            read_at = now(),
            updated_at = now()
        where org_id = ${tx.orgId}
      `;
    },
  };
}
