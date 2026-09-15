/** The maintenance ladder from DOMAIN.md. */
// In shared/domain because the public status payload names this ladder too.
// Re-exported so maintenance code keeps importing it from its own module.
import type { MaintenanceStatus } from '@/shared/domain/status-inputs';

export {
  MAINTENANCE_STATUSES,
  type MaintenanceStatus,
} from '@/shared/domain/status-inputs';

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
