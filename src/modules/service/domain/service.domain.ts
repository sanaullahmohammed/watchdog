import { randomUUID } from 'node:crypto';
import type {
  CreateServiceProps,
  ServiceEntity,
} from '@/modules/service/domain/service.types';

export default function serviceDomain() {
  return {
    createService: (
      orgId: string,
      create: CreateServiceProps,
    ): ServiceEntity => {
      const now = new Date();

      return {
        id: randomUUID(),
        orgId,
        serviceGroupId: create.serviceGroupId ?? null,
        name: create.name,
        slug: create.slug,
        description: create.description ?? null,
        manualStatusOverride: null,
        isPublic: create.isPublic ?? true,
        displayOrder: create.displayOrder ?? 0,
        archivedAt: null,
        // Derived; only the recomputation handler moves it after creation.
        lastKnownStatus: 'operational',
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}
