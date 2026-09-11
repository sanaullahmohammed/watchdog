/** The incident ladder from DOMAIN.md. There is no `dismissed` status. */
export const INCIDENT_STATUSES = [
  'draft',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

// The impact ladder is read by the service module when resolving status, so it
// lives in shared and is re-exported here for this module's existing importers.
export {
  INCIDENT_IMPACTS,
  type IncidentImpact,
} from '@/shared/domain/status-inputs';

/** How an incident came to exist. */
export const INCIDENT_SOURCES = [
  'manual',
  'monitoring',
  'ai_assisted',
] as const;

export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

/** `null` is DOMAIN's `[none]`: the incident does not exist yet. */
export type IncidentStatusOrNew = IncidentStatus | null;
