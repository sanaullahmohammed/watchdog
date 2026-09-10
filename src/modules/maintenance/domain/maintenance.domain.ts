import { randomUUID } from 'node:crypto';
import { InvalidMaintenanceWindowError } from '@/modules/maintenance/domain/maintenance.errors';
import type {
  MaintenanceEntity,
  ScheduleMaintenanceProps,
} from '@/modules/maintenance/domain/maintenance.types';

export default function maintenanceDomain() {
  return {
    assertWindow(start: Date, end: Date) {
      // Also a CHECK constraint. Raised here so a caller gets a domain error
      // naming both ends rather than a constraint violation.
      if (end.getTime() <= start.getTime()) {
        throw new InvalidMaintenanceWindowError(start, end);
      }
    },

    scheduleMaintenance(
      orgId: string,
      createdByUserId: string | null,
      create: ScheduleMaintenanceProps,
    ): MaintenanceEntity {
      this.assertWindow(create.scheduledStartAt, create.scheduledEndAt);
      const now = new Date();

      return {
        id: randomUUID(),
        orgId,
        title: create.title,
        description: create.description ?? null,
        // Every window begins scheduled. Only the worker, or a human
        // completing early, moves it on. See DOMAIN.md's transition table.
        status: 'scheduled',
        scheduledStartAt: create.scheduledStartAt,
        scheduledEndAt: create.scheduledEndAt,
        startedAt: null,
        completedAt: null,
        createdByUserId,
        createdAt: now,
        updatedAt: now,
        affectedServiceIds: create.affectedServiceIds ?? [],
      };
    },
  };
}
