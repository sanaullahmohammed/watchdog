import type { IncidentEntity } from '@/modules/incident/domain/incident.domain';
import type {
  IncidentImpact,
  IncidentSource,
  IncidentStatus,
} from '@/modules/incident/domain/incident.types';

export interface IncidentModel {
  id: string;
  org_id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  started_at: Date;
  resolved_at: Date | null;
  created_by_user_id: string | null;
  origin_monitor_id: string | null;
  source: IncidentSource;
  created_at: Date;
  updated_at: Date;
}

export default function incidentMapper() {
  return {
    toDomain: (
      row: IncidentModel,
      affectedServices: { serviceId: string; impact: IncidentImpact }[] = [],
    ): IncidentEntity => ({
      id: row.id,
      orgId: row.org_id,
      title: row.title,
      status: row.status,
      impact: row.impact,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      createdByUserId: row.created_by_user_id,
      originMonitorId: row.origin_monitor_id,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      affectedServices,
    }),
  };
}
