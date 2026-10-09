import type {
  MonitorConfig,
  MonitorEntity,
  MonitorType,
} from '@/modules/monitoring/domain/monitor.types';

/** The row shape as Postgres returns it: snake_case, dates as Date. */
export interface MonitorModel {
  id: string;
  org_id: string;
  service_id: string;
  type: MonitorType;
  name: string;
  target: string;
  interval_seconds: number;
  timeout_seconds: number;
  enabled: boolean;
  failure_threshold: number;
  config: MonitorConfig;
  consecutive_failures: number;
  failure_episode: number;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export default function monitorMapper() {
  return {
    toDomain: (row: MonitorModel): MonitorEntity => ({
      id: row.id,
      orgId: row.org_id,
      serviceId: row.service_id,
      type: row.type,
      name: row.name,
      target: row.target,
      intervalSeconds: row.interval_seconds,
      timeoutSeconds: row.timeout_seconds,
      enabled: row.enabled,
      failureThreshold: row.failure_threshold,
      config: row.config,
      consecutiveFailures: row.consecutive_failures,
      failureEpisode: row.failure_episode,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  };
}
