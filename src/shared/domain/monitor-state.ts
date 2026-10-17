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

/**
 * The failure episode after a move from `before` to `after`: one more when the
 * monitor enters `failing`, otherwise unchanged. Never reset. Shared by checks
 * and edits so the two cannot disagree.
 */
export function failureEpisodeAfter(
  before: MonitorDerivedState | null,
  after: MonitorDerivedState | null,
  episode: number,
): number {
  return after === 'failing' && before !== 'failing' ? episode + 1 : episode;
}

const MONITOR_STATE_RANK: Record<MonitorDerivedState, number> = {
  healthy: 0,
  degraded: 1,
  failing: 2,
};

/**
 * A service's monitor-derived state: the worst `monitorStateOf` among its
 * monitors, `failing` over `degraded` over `healthy`. Null when none
 * contributes (no monitors, or all disabled or never checked).
 */
export function serviceMonitorStateOf(
  monitors: MonitorStateInput[],
): MonitorDerivedState | null {
  let worst: MonitorDerivedState | null = null;
  for (const monitor of monitors) {
    const state = monitorStateOf(monitor);
    if (
      state !== null &&
      (worst === null || MONITOR_STATE_RANK[state] > MONITOR_STATE_RANK[worst])
    ) {
      worst = state;
    }
  }
  return worst;
}
