import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * Tenant-scoped. Days are `YYYY-MM-DD` strings throughout, read with `::text`
 * so the driver never turns a date into a `Date` in the process's time zone.
 * Every day is a UTC day, spelled out in the SQL so no session time zone can
 * move a result across midnight.
 */
export default function uptimeRollupRepository() {
  return {
    /** Today and yesterday by the database's clock, as UTC days. */
    async clock(tx: TenantTransaction) {
      const rows = await tx.sql<{ today: string; yesterday: string }[]>`
        select
          (now() at time zone 'UTC')::date::text as today,
          ((now() at time zone 'UTC')::date - 1)::text as yesterday
      `;
      return rows[0];
    },

    async getProgress(tx: TenantTransaction, orgId: string) {
      const rows = await tx.sql<{ day: string }[]>`
        select refreshed_through::text as day
        from uptime_rollup_progress
        where org_id = ${orgId}
      `;
      return rows[0]?.day ?? null;
    },

    /**
     * Writes the watermark. Callers do so only when the value changes, so an
     * idle pass leaves the row, `updated_at` included, as it was.
     */
    async setProgress(tx: TenantTransaction, orgId: string, day: string) {
      await tx.sql`
        insert into uptime_rollup_progress (org_id, refreshed_through)
        values (${orgId}, ${day}::date)
        on conflict (org_id) do update set
          refreshed_through = excluded.refreshed_through,
          updated_at = now()
      `;
    },

    /** The UTC day of the organization's oldest retained result, or null. */
    async oldestResultDay(tx: TenantTransaction, orgId: string) {
      const rows = await tx.sql<{ day: string | null }[]>`
        select (min(checked_at) at time zone 'UTC')::date::text as day
        from check_results
        where org_id = ${orgId}
      `;
      return rows[0].day;
    },

    /**
     * Recomputes every day from `from` through `through` inclusive (UTC days)
     * in one statement. A day with no results writes nothing, and a row whose
     * six aggregates did not change is not rewritten. Returns how many rows
     * were inserted or changed.
     */
    async refresh(
      tx: TenantTransaction,
      orgId: string,
      from: string,
      through: string,
    ) {
      const rows = await tx.sql`
        insert into uptime_rollups (
          org_id, service_id, day, total_checks, successful_checks,
          failed_checks, uptime_ratio, avg_latency_ms, worst_status
        )
        select
          cr.org_id,
          cr.service_id,
          (cr.checked_at at time zone 'UTC')::date as day,
          count(*)::integer,
          count(*) filter (where cr.status = 'success')::integer,
          count(*) filter (where cr.status = 'failure')::integer,
          count(*) filter (where cr.status = 'success')::numeric
            / count(*)::numeric,
          avg(cr.latency_ms) filter (where cr.status = 'success'),
          case
            when count(*) filter (where cr.status = 'failure') = 0
              then 'operational'
            when count(*) filter (where cr.status = 'failure') < count(*)
              then 'degraded'
            else 'major_outage'
          end
        from check_results cr
        where cr.org_id = ${orgId}
          and cr.checked_at >= (${from}::date::timestamp at time zone 'UTC')
          and cr.checked_at < ((${through}::date + 1)::timestamp at time zone 'UTC')
        group by cr.org_id, cr.service_id, (cr.checked_at at time zone 'UTC')::date
        on conflict (org_id, service_id, day) do update set
          total_checks = excluded.total_checks,
          successful_checks = excluded.successful_checks,
          failed_checks = excluded.failed_checks,
          uptime_ratio = excluded.uptime_ratio,
          avg_latency_ms = excluded.avg_latency_ms,
          worst_status = excluded.worst_status,
          updated_at = now()
        where (
          uptime_rollups.total_checks,
          uptime_rollups.successful_checks,
          uptime_rollups.failed_checks,
          uptime_rollups.uptime_ratio,
          uptime_rollups.avg_latency_ms,
          uptime_rollups.worst_status
        ) is distinct from (
          excluded.total_checks,
          excluded.successful_checks,
          excluded.failed_checks,
          excluded.uptime_ratio,
          excluded.avg_latency_ms,
          excluded.worst_status
        )
        returning 1
      `;
      return rows.length;
    },

    /** Deletes this organization's rollups older than `retentionDays` before `today`. */
    async prune(
      tx: TenantTransaction,
      orgId: string,
      today: string,
      retentionDays: number,
    ) {
      const rows = await tx.sql`
        delete from uptime_rollups
        where org_id = ${orgId}
          and day < (${today}::date - ${retentionDays}::int)
        returning 1
      `;
      return rows.length;
    },
  };
}
