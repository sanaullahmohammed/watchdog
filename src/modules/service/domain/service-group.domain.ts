import { randomUUID } from 'node:crypto';
import type {
  CreateServiceGroupProps,
  ServiceGroupEntity,
} from '@/modules/service/domain/service-group.types';

export default function serviceGroupDomain() {
  return {
    createServiceGroup: (
      orgId: string,
      create: CreateServiceGroupProps,
    ): ServiceGroupEntity => {
      const now = new Date();

      return {
        id: randomUUID(),
        orgId,
        name: create.name,
        slug: create.slug,
        displayOrder: create.displayOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}
