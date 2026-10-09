import sql from '@/shared/db/postgres';

/**
 * Calls the two owner-owned SECURITY DEFINER functions that create and drop
 * `check_results` partitions (ARCHITECTURE.md 6.1). Not tenant-scoped: it is
 * partition DDL, so it uses the global connection and no tenant transaction.
 * A refusal surfaces as SQLSTATE 22023 and is let through.
 */
export default function checkResultPartitionRepository() {
  return {
    async createPartitions(from?: Date | string): Promise<number> {
      const fromDate =
        from instanceof Date ? from.toISOString().slice(0, 10) : (from ?? null);
      const rows = await sql<{ created: number }[]>`
        select public.create_check_result_partitions(${fromDate}::date) as created
      `;
      return rows[0].created;
    },

    async dropExpired(retentionDays: number): Promise<number> {
      const rows = await sql<{ dropped: number }[]>`
        select public.drop_expired_check_result_partitions(${retentionDays}::int) as dropped
      `;
      return rows[0].dropped;
    },
  };
}
