import type { ServiceGroupRepository } from '@/modules/service/database/service-group.repository.port';
import { ServiceGroupSlugAlreadyExistsError } from '@/modules/service/domain/service.errors';
import type {
  ServiceGroupEntity,
  UpdateServiceGroupProps,
} from '@/modules/service/domain/service-group.types';
import type { ServiceGroupModel } from '@/modules/service/service-group.mapper';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

const UNIQUE_VIOLATION = '23505';

export default function serviceGroupRepository({
  serviceGroupMapper,
}: Dependencies): ServiceGroupRepository {
  return {
    async insert(tx: TenantTransaction, group: ServiceGroupEntity) {
      try {
        await tx.sql`
          insert into service_groups (
            id, org_id, name, slug, display_order, created_at, updated_at
          ) values (
            ${group.id}, ${group.orgId}, ${group.name}, ${group.slug},
            ${group.displayOrder}, ${group.createdAt}, ${group.updatedAt}
          )
        `;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ServiceGroupSlugAlreadyExistsError(
            group.slug,
            error as Error,
          );
        }
        throw error;
      }
    },

    async update(
      tx: TenantTransaction,
      id: string,
      patch: UpdateServiceGroupProps,
    ) {
      const columns: Record<string, unknown> = {};
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.slug !== undefined) columns.slug = patch.slug;
      if (patch.displayOrder !== undefined) {
        columns.display_order = patch.displayOrder;
      }

      if (Object.keys(columns).length === 0) {
        const rows = await tx.sql<ServiceGroupModel[]>`
          select * from service_groups where id = ${id} limit 1
        `;
        return rows[0] ? serviceGroupMapper.toDomain(rows[0]) : undefined;
      }

      columns.updated_at = new Date();

      try {
        const rows = await tx.sql<ServiceGroupModel[]>`
          update service_groups set ${tx.sql(columns)}
          where id = ${id}
          returning *
        `;
        return rows[0] ? serviceGroupMapper.toDomain(rows[0]) : undefined;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ServiceGroupSlugAlreadyExistsError(
            patch.slug ?? '',
            error as Error,
          );
        }
        throw error;
      }
    },

    async remove(tx: TenantTransaction, id: string) {
      // Services referencing this group are ungrouped by the foreign key's
      // ON DELETE SET NULL, not deleted. See DOMAIN.md, Tenant-scoped foreign keys.
      const rows = await tx.sql<ServiceGroupModel[]>`
        delete from service_groups where id = ${id} returning *
      `;
      return rows[0] ? serviceGroupMapper.toDomain(rows[0]) : undefined;
    },
  };
}
