import type {
  MaintenanceEntity,
  MaintenanceStatus,
} from '@/modules/maintenance/domain/maintenance.types';

export interface MaintenanceModel {
  id: string;
  org_id: string;
  title: string;
  description: string | null;
  status: MaintenanceStatus;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export default function maintenanceMapper() {
  return {
    toDomain: (
      row: MaintenanceModel,
      affectedServiceIds: string[] = [],
    ): MaintenanceEntity => ({
      id: row.id,
      orgId: row.org_id,
      title: row.title,
      description: row.description,
      status: row.status,
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      affectedServiceIds,
    }),
  };
}
