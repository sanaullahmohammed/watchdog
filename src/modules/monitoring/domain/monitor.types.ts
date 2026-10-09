import type { Static } from 'typebox';
import type { MonitorDerivedState } from '@/shared/domain/status-inputs';
import type { MONITOR_TYPES, monitorConfigSchema } from './monitor-limits';

export type MonitorType = (typeof MONITOR_TYPES)[number];

export type MonitorConfig = Static<typeof monitorConfigSchema>;

export type { MonitorDerivedState };

/** What a caller supplies to create a monitor. `orgId` is never among them. */
export interface CreateMonitorProps {
  serviceId: string;
  type: MonitorType;
  name: string;
  target: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  enabled?: boolean;
  config?: MonitorConfig;
}

/** The mutable subset: `type` and `serviceId` are fixed at creation. */
export interface UpdateMonitorProps {
  name?: string;
  target?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  enabled?: boolean;
  config?: MonitorConfig;
}

export interface MonitorEntity {
  id: string;
  orgId: string;
  serviceId: string;
  type: MonitorType;
  name: string;
  target: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  enabled: boolean;
  failureThreshold: number;
  config: MonitorConfig;
  consecutiveFailures: number;
  failureEpisode: number;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
