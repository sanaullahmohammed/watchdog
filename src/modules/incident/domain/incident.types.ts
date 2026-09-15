/** The incident ladder from DOMAIN.md. There is no `dismissed` status. */
// Both ladders live in shared/domain: the service module reads impact when it
// resolves status, and the public status payload names the lifecycle. Modules
// may not import one another, so they live there and are re-exported here for
// this module's own importers.
import type { IncidentStatus } from '@/shared/domain/status-inputs';

export {
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  type IncidentImpact,
  type IncidentStatus,
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
