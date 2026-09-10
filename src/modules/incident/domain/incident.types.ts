/** The incident ladder from DOMAIN.md. There is no `dismissed` status. */
export const INCIDENT_STATUSES = [
  'draft',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Per-service and overall impact, from DOMAIN.md. */
export const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;

export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

/** How an incident came to exist. */
export const INCIDENT_SOURCES = [
  'manual',
  'monitoring',
  'ai_assisted',
] as const;

export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

/** `null` is DOMAIN's `[none]`: the incident does not exist yet. */
export type IncidentStatusOrNew = IncidentStatus | null;
