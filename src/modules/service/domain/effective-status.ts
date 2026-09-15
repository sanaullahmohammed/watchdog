import type { ServiceStatus } from '@/modules/service/domain/service.types';
import {
  type IncidentImpact,
  type MonitorDerivedState,
  worstServiceStatus,
} from '@/shared/domain/status-inputs';

export { SERVICE_STATUS_RANK } from '@/shared/domain/status-inputs';

export function statusFromIncidentImpact(
  impact: IncidentImpact,
): ServiceStatus {
  switch (impact) {
    case 'none':
      return 'operational';
    case 'minor':
      return 'degraded';
    case 'major':
      return 'partial_outage';
    case 'critical':
      return 'major_outage';
  }
}

export function statusFromMonitorState(
  state: MonitorDerivedState,
): ServiceStatus {
  switch (state) {
    case 'healthy':
      return 'operational';
    case 'degraded':
      return 'degraded';
    case 'failing':
      return 'major_outage';
  }
}

export type ResolveServiceStatusInput = {
  manualOverride: ServiceStatus | null;
  /** Every active incident naming this service. Reduced, never sampled. */
  activeIncidentImpacts: readonly IncidentImpact[];
  hasActiveMaintenance: boolean;
  /**
   * Null when the service has no monitor. DOMAIN's sketch types this as always
   * present; a service with no monitor contributes nothing, which is what
   * `operational` as the reduction's identity already expresses.
   */
  monitorState: MonitorDerivedState | null;
};

/**
 * Effective service status, transcribed from DOMAIN.md's Status model.
 *
 * A manual override wins outright. Otherwise the result is the WORST of every
 * input, not the first input present: a cascade would let an active `none`
 * incident hide an in-progress maintenance window, and would let the first of
 * several incidents stand in for all of them. Story work once described this as
 * a cascade, and DOMAIN now says so in as many words. The reduction itself is
 * `worstServiceStatus`, which the public payload also uses for its banner.
 */
export function resolveServiceStatus(
  input: ResolveServiceStatusInput,
): ServiceStatus {
  if (input.manualOverride !== null) {
    return input.manualOverride;
  }

  return worstServiceStatus([
    ...input.activeIncidentImpacts.map(statusFromIncidentImpact),
    ...(input.hasActiveMaintenance ? (['maintenance'] as const) : []),
    ...(input.monitorState ? [statusFromMonitorState(input.monitorState)] : []),
  ]);
}
