/**
 * Value ladders that cross module boundaries.
 *
 * Effective service status reads incident impact, which the `incident` module
 * produces, and monitor-derived state, which `monitoring` will. The public
 * status payload reads all three lifecycles at once. Modules may not import one
 * another, so every ladder more than one module names lives here rather than
 * inside any one producer, and each module re-exports what it owns. So do the
 * subsets of a ladder that cross modules. Rules over those ladders that more
 * than one module applies live here too: the worst-of
 * reduction, and the mapping from incident impact to service status, which the
 * status recomputation and the public page's banner both use. See DOMAIN.md,
 * Status model.
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

/** The service status ladder from DOMAIN.md, worst last by the rank below. */
export const SERVICE_STATUSES = [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/**
 * DOMAIN's ordering. `maintenance` is visible and non-operational, but every
 * incident outage state outranks it: a major incident during planned work
 * reads as an outage, not as maintenance.
 */
export const SERVICE_STATUS_RANK: Readonly<Record<ServiceStatus, number>> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

/**
 * The worst of several statuses. `operational` is the reduction's identity, so
 * an empty list is operational: an organization with nothing to report is not
 * broken.
 */
export function worstServiceStatus(
  statuses: readonly ServiceStatus[],
): ServiceStatus {
  return statuses.reduce<ServiceStatus>(
    (worst, current) =>
      SERVICE_STATUS_RANK[current] > SERVICE_STATUS_RANK[worst]
        ? current
        : worst,
    'operational',
  );
}

/**
 * DOMAIN's impact mapping. A `major` incident is a partial outage; only a
 * `critical` one is a major outage.
 */
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

/**
 * What a day of monitor checks can say, from DOMAIN's `uptime_rollups`: a
 * deliberate three-level scale, computed from `check_results` alone and never
 * folding in incidents or maintenance. A subset of `SERVICE_STATUSES`, and not
 * `MONITOR_DERIVED_STATES`, which names the same idea differently for
 * precedence. Epic 5 fills the rollups; the public page's uptime day carries
 * this today so the contract does not change when it does.
 */
export const UPTIME_DAY_STATUSES = [
  'operational',
  'degraded',
  'major_outage',
] as const;

export type UptimeDayStatus = (typeof UPTIME_DAY_STATUSES)[number];

/** The incident lifecycle from DOMAIN.md. */
export const INCIDENT_STATUSES = [
  'draft',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The maintenance lifecycle from DOMAIN.md. */
export const MAINTENANCE_STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
] as const;

export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];
