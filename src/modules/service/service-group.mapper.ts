import type { ServiceGroupEntity } from '@/modules/service/domain/service-group.types';

export interface ServiceGroupModel {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export default function serviceGroupMapper() {
  return {
    toDomain: (row: ServiceGroupModel): ServiceGroupEntity => ({
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      slug: row.slug,
      displayOrder: row.display_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  };
}
