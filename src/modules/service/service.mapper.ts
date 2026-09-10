import type {
  ServiceEntity,
  ServiceStatus,
} from '@/modules/service/domain/service.types';

/** The row shape as Postgres returns it: snake_case, dates as Date. */
export interface ServiceModel {
  id: string;
  org_id: string;
  service_group_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  manual_status_override: ServiceStatus | null;
  is_public: boolean;
  display_order: number;
  archived_at: Date | null;
  last_known_status: ServiceStatus;
  created_at: Date;
  updated_at: Date;
}

export default function serviceMapper() {
  return {
    toDomain: (row: ServiceModel): ServiceEntity => ({
      id: row.id,
      orgId: row.org_id,
      serviceGroupId: row.service_group_id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      manualStatusOverride: row.manual_status_override,
      isPublic: row.is_public,
      displayOrder: row.display_order,
      archivedAt: row.archived_at,
      lastKnownStatus: row.last_known_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  };
}
