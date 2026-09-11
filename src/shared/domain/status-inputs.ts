/**
 * Value ladders that cross module boundaries.
 *
 * Effective service status reads incident impact, which the `incident` module
 * produces, and monitor-derived state, which `monitoring` will. Modules may not
 * import one another, so the ladders both sides agree on live here rather than
 * inside either producer. See DOMAIN.md, Status model.
 */

/** Per-service and overall incident impact. */
export const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;

export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

/** What a service's monitors currently say, before precedence is applied. */
export const MONITOR_DERIVED_STATES = [
  'healthy',
  'degraded',
  'failing',
] as const;

export type MonitorDerivedState = (typeof MONITOR_DERIVED_STATES)[number];
