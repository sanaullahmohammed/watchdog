import type { MaintenanceRepository } from '@/modules/maintenance/database/maintenance.repository.port';
import { UnknownMaintenanceServiceError } from '@/modules/maintenance/domain/maintenance.errors';
import type {
  MaintenanceEntity,
  UpdateMaintenanceProps,
} from '@/modules/maintenance/domain/maintenance.types';
import type { MaintenanceModel } from '@/modules/maintenance/maintenance.mapper';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

const FOREIGN_KEY_VIOLATION = '23503';

export default function maintenanceRepository({
  maintenanceMapper,
}: Dependencies): MaintenanceRepository {
  async function affectedServiceIds(tx: TenantTransaction, id: string) {
    const rows = await tx.sql<{ service_id: string }[]>`
      select service_id from maintenance_services
      where maintenance_id = ${id}
      order by service_id
    `;
    return rows.map((row) => row.service_id);
  }

  return {
    async insert(tx: TenantTransaction, window: MaintenanceEntity) {
      await tx.sql`
        insert into maintenance (
          id, org_id, title, description, status,
          scheduled_start_at, scheduled_end_at, created_by_user_id,
          created_at, updated_at
        ) values (
          ${window.id}, ${window.orgId}, ${window.title}, ${window.description},
          ${window.status}, ${window.scheduledStartAt}, ${window.scheduledEndAt},
          ${window.createdByUserId}, ${window.createdAt}, ${window.updatedAt}
        )
      `;

      await this.replaceAffectedServices(tx, window, window.affectedServiceIds);
    },

    async update(
      tx: TenantTransaction,
      id: string,
      patch: UpdateMaintenanceProps,
    ) {
      const columns: Record<string, unknown> = {};
      if (patch.title !== undefined) columns.title = patch.title;
      if (patch.description !== undefined) {
        columns.description = patch.description;
      }
      if (patch.scheduledStartAt !== undefined) {
        columns.scheduled_start_at = patch.scheduledStartAt;
      }
      if (patch.scheduledEndAt !== undefined) {
        columns.scheduled_end_at = patch.scheduledEndAt;
      }

      if (Object.keys(columns).length === 0) {
        return this.findById(tx, id);
      }

      columns.updated_at = new Date();

      // No try/catch around the CHECK here on purpose. A constraint violation
      // aborts the transaction, so anything this handler did afterwards to
      // build a better error - a read, for instance - would itself fail. The
      // window is validated before the write instead; the CHECK is the backstop
      // for writers that do not go through this path.
      const rows = await tx.sql<MaintenanceModel[]>`
        update maintenance set ${tx.sql(columns)} where id = ${id} returning *
      `;
      if (!rows[0]) return undefined;
      return maintenanceMapper.toDomain(
        rows[0],
        await affectedServiceIds(tx, id),
      );
    },

    async replaceAffectedServices(
      tx: TenantTransaction,
      window: MaintenanceEntity,
      serviceIds: string[],
    ) {
      await tx.sql`
        delete from maintenance_services where maintenance_id = ${window.id}
      `;

      if (serviceIds.length === 0) return;

      try {
        await tx.sql`
          insert into maintenance_services ${tx.sql(
            serviceIds.map((serviceId) => ({
              org_id: window.orgId,
              maintenance_id: window.id,
              service_id: serviceId,
            })),
          )}
        `;
      } catch (error) {
        if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new UnknownMaintenanceServiceError(error as Error);
        }
        throw error;
      }
    },

    async findById(tx: TenantTransaction, id: string) {
      const rows = await tx.sql<MaintenanceModel[]>`
        select * from maintenance where id = ${id} limit 1
      `;
      if (!rows[0]) return undefined;
      return maintenanceMapper.toDomain(
        rows[0],
        await affectedServiceIds(tx, id),
      );
    },
  };
}
