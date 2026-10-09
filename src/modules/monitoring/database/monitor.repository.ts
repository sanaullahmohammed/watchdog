import { MonitorServiceNotFoundError } from '@/modules/monitoring/domain/monitor.errors';
import type { MonitorEntity } from '@/modules/monitoring/domain/monitor.types';
import type { MonitorModel } from '@/modules/monitoring/monitor.mapper';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Tenant-scoped: every method takes the caller's `TenantTransaction`. It does
 * not implement `RepositoryPort`, as AGENTS.md records.
 */
export default function monitorRepository({ monitorMapper }: Dependencies) {
  return {
    async insert(tx: TenantTransaction, monitor: MonitorEntity) {
      try {
        await tx.sql`
          insert into monitors (
            id, org_id, service_id, type, name, target, interval_seconds,
            timeout_seconds, enabled, failure_threshold, config,
            consecutive_failures, failure_episode, last_checked_at,
            created_at, updated_at
          ) values (
            ${monitor.id}, ${monitor.orgId}, ${monitor.serviceId},
            ${monitor.type}, ${monitor.name}, ${monitor.target},
            ${monitor.intervalSeconds}, ${monitor.timeoutSeconds},
            ${monitor.enabled}, ${monitor.failureThreshold},
            ${tx.sql.json(monitor.config)}, ${monitor.consecutiveFailures},
            ${monitor.failureEpisode}, ${monitor.lastCheckedAt},
            ${monitor.createdAt}, ${monitor.updatedAt}
          )
        `;
      } catch (error) {
        // The key spans (service_id, org_id), so an unknown service, or one in
        // another organization, fails here rather than as a masked 500.
        if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new MonitorServiceNotFoundError(
            monitor.serviceId,
            error as Error,
          );
        }
        throw error;
      }
    },

    async findById(tx: TenantTransaction, id: string) {
      const rows = await tx.sql<MonitorModel[]>`
        select * from monitors where id = ${id} limit 1
      `;
      return rows[0] ? monitorMapper.toDomain(rows[0]) : undefined;
    },

    /**
     * Every monitor of a service. Names are not unique, so the order ends at
     * `id`, and a page of them cannot swap two between requests.
     */
    async listByService(tx: TenantTransaction, serviceId: string) {
      const rows = await tx.sql<MonitorModel[]>`
        select * from monitors
        where service_id = ${serviceId}
        order by name asc, id asc
      `;
      return rows.map(monitorMapper.toDomain);
    },

    /**
     * The row, locked `for no key update`. A read-check-write is not serialized
     * by the transaction alone; this is what makes two concurrent edits queue.
     */
    async getForUpdate(tx: TenantTransaction, id: string) {
      const rows = await tx.sql<MonitorModel[]>`
        select * from monitors where id = ${id} limit 1 for no key update
      `;
      return rows[0] ? monitorMapper.toDomain(rows[0]) : undefined;
    },

    /** Writes every mutable column of a row the caller has locked. */
    async update(tx: TenantTransaction, monitor: MonitorEntity) {
      await tx.sql`
        update monitors set
          name = ${monitor.name},
          target = ${monitor.target},
          interval_seconds = ${monitor.intervalSeconds},
          timeout_seconds = ${monitor.timeoutSeconds},
          enabled = ${monitor.enabled},
          failure_threshold = ${monitor.failureThreshold},
          config = ${tx.sql.json(monitor.config)},
          consecutive_failures = ${monitor.consecutiveFailures},
          failure_episode = ${monitor.failureEpisode},
          last_checked_at = ${monitor.lastCheckedAt},
          updated_at = ${monitor.updatedAt}
        where id = ${monitor.id}
      `;
    },
  };
}
