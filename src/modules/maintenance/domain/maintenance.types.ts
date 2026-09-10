/** The maintenance ladder from DOMAIN.md. */
export const MAINTENANCE_STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
] as const;

export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export interface ScheduleMaintenanceProps {
  title: string;
  description?: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  affectedServiceIds?: string[];
}

export interface UpdateMaintenanceProps {
  title?: string;
  description?: string | null;
  scheduledStartAt?: Date;
  scheduledEndAt?: Date;
}

export interface MaintenanceEntity {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  affectedServiceIds: string[];
}
