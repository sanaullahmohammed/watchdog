import type { MonitorDerivedState } from '@/shared/domain/status-inputs';

/** What the rule reads from a monitor's stored row. */
export interface MonitorStateInput {
  enabled: boolean;
  lastCheckedAt: Date | null;
  consecutiveFailures: number;
  failureThreshold: number;
}

/**
 * DOMAIN's M1: how a monitor's derived state follows from its stored row.
 *
 * Null when the monitor contributes nothing: it is disabled, or it has never
 * been checked. Otherwise `healthy` at 0 failures, `degraded` below the
 * threshold, `failing` at or above it. A pure function of rows, never of
 * events, so a reconciliation can recompute it after a lost one. Used by
 * `monitoring` (checks and edits) and by `service` (status recomputation).
 */
export function monitorStateOf(
  monitor: MonitorStateInput,
): MonitorDerivedState | null {
  if (!monitor.enabled || monitor.lastCheckedAt === null) {
    return null;
  }
  if (monitor.consecutiveFailures <= 0) {
    return 'healthy';
  }
  return monitor.consecutiveFailures >= monitor.failureThreshold
    ? 'failing'
    : 'degraded';
}
