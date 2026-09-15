import { randomUUID } from 'node:crypto';
import {
  CompletedMaintenanceImmutableError,
  InvalidMaintenanceWindowError,
  MaintenanceNotDeletableError,
  RunningMaintenanceFieldsError,
} from '@/modules/maintenance/domain/maintenance.errors';
import type {
  MaintenanceEntity,
  MaintenanceStatus,
  ScheduleMaintenanceProps,
  UpdateMaintenanceProps,
} from '@/modules/maintenance/domain/maintenance.types';

/** What an edit may carry, including the affected services the patch omits. */
export type MaintenanceEdit = UpdateMaintenanceProps & {
  affectedServiceIds?: string[];
};

/** Locked once a window is running: they describe a window that has begun. */
const LOCKED_WHILE_RUNNING = [
  'title',
  'description',
  'scheduledStartAt',
] as const;

export default function maintenanceDomain() {
  return {
    assertWindow(start: Date, end: Date) {
      // Also a CHECK constraint. Raised here so a caller gets a domain error
      // naming both ends rather than a constraint violation.
      if (end.getTime() <= start.getTime()) {
        throw new InvalidMaintenanceWindowError(start, end);
      }
    },

    /**
     * Deleting is for work that never happened, so only a scheduled window may
     * go. Anything that started or finished is completed instead, which keeps
     * the record. DOMAIN.md, Maintenance state machine.
     */
    assertDeletable(status: MaintenanceStatus) {
      if (status !== 'scheduled') {
        throw new MaintenanceNotDeletableError(status);
      }
    },

    /**
     * What may change, and when. A completed window is history. A running one
     * may be extended, or have its affected services corrected, which are the
     * two things an operator genuinely needs mid-window; its title,
     * description and start describe a window that has already begun.
     */
    assertEditable(status: MaintenanceStatus, edit: MaintenanceEdit) {
      if (status === 'completed') {
        throw new CompletedMaintenanceImmutableError();
      }
      if (status !== 'in_progress') {
        return;
      }
      const locked = LOCKED_WHILE_RUNNING.filter(
        (field) => edit[field] !== undefined,
      );
      if (locked.length > 0) {
        throw new RunningMaintenanceFieldsError(locked);
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
