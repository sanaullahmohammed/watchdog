import type { ServiceRepository } from '@/modules/service/database/service.repository.port';
import {
  ServiceGroupNotInOrganizationError,
  ServiceSlugAlreadyExistsError,
} from '@/modules/service/domain/service.errors';
import type {
  ServiceEntity,
  UpdateServiceProps,
} from '@/modules/service/domain/service.types';
import type { ServiceModel } from '@/modules/service/service.mapper';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export default function serviceRepository({
  serviceMapper,
}: Dependencies): ServiceRepository {
  return {
    async insert(tx: TenantTransaction, service: ServiceEntity) {
      try {
        await tx.sql`
          insert into services (
            id, org_id, service_group_id, name, slug, description,
            is_public, display_order, last_known_status, created_at, updated_at
          ) values (
            ${service.id}, ${service.orgId}, ${service.serviceGroupId},
            ${service.name}, ${service.slug}, ${service.description},
            ${service.isPublic}, ${service.displayOrder},
            ${service.lastKnownStatus}, ${service.createdAt}, ${service.updatedAt}
          )
        `;
      } catch (error) {
        // (org_id, slug) is unique across archived services too, so this fires
        // for a slug an archived service still reserves.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ServiceSlugAlreadyExistsError(service.slug, error as Error);
        }
        throw error;
      }
    },

    async update(
      tx: TenantTransaction,
      id: string,
      patch: UpdateServiceProps,
    ): Promise<ServiceEntity | undefined> {
      // Only keys actually present are written. `coalesce` would conflate
      // "not supplied" with "set to null" and make a nullable column
      // impossible to clear on purpose.
      const columns: Record<string, unknown> = {};
      if (patch.name !== undefined) columns.name = patch.name;
      if (patch.description !== undefined) {
        columns.description = patch.description;
      }
      if (patch.isPublic !== undefined) columns.is_public = patch.isPublic;
      if (patch.displayOrder !== undefined) {
        columns.display_order = patch.displayOrder;
      }
      if (patch.serviceGroupId !== undefined) {
        columns.service_group_id = patch.serviceGroupId;
      }

      if (Object.keys(columns).length === 0) {
        return this.findById(tx, id);
      }

      columns.updated_at = new Date();

      // RLS scopes the write; a row belonging to another organization simply
      // matches nothing and returns undefined rather than raising.
      try {
        const rows = await tx.sql<ServiceModel[]>`
          update services set ${tx.sql(columns)}
          where id = ${id}
          returning *
        `;

        return rows[0] ? serviceMapper.toDomain(rows[0]) : undefined;
      } catch (error) {
        // The foreign key spans (service_group_id, org_id), so a group in
        // another organization fails here rather than being silently accepted.
        // Reported as an invalid argument rather than leaking that the group
        // exists somewhere else.
        if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new ServiceGroupNotInOrganizationError(
            String(patch.serviceGroupId),
            error as Error,
          );
        }
        throw error;
      }
    },

    async archive(tx: TenantTransaction, id: string) {
      // The `archived_at is null` guard makes the write idempotent at the
      // database rather than in a read-then-write, which two concurrent
      // requests could both pass.
      const rows = await tx.sql<ServiceModel[]>`
        update services set archived_at = now(), updated_at = now()
        where id = ${id} and archived_at is null
        returning *
      `;
      return rows[0] ? serviceMapper.toDomain(rows[0]) : undefined;
    },

    async restore(tx: TenantTransaction, id: string) {
      const rows = await tx.sql<ServiceModel[]>`
        update services set archived_at = null, updated_at = now()
        where id = ${id} and archived_at is not null
        returning *
      `;
      return rows[0] ? serviceMapper.toDomain(rows[0]) : undefined;
    },

    async findById(tx: TenantTransaction, id: string) {
      const rows = await tx.sql<ServiceModel[]>`
        select * from services where id = ${id} limit 1
      `;
      return rows[0] ? serviceMapper.toDomain(rows[0]) : undefined;
    },
  };
}
