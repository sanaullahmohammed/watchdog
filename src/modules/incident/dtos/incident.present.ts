import type { IncidentEntity } from '@/modules/incident/domain/incident.domain';
import type {
  IncidentResponseDto,
  IncidentUpdateResponseDto,
} from '@/modules/incident/dtos/incident.response.dto';
import type { IncidentTimelineEntry } from '@/modules/incident/queries/get-incident-timeline/get-incident-timeline.handler';

/**
 * One presenter for both surfaces, as the service and maintenance modules
 * already have. The parity contract compares the request shapes each surface
 * accepts, never the responses they build, so two hand-written mappings could
 * drift apart and the build would stay green. Epic 2 retrospective, AV-4.
 */
export function toIncidentResponse(
  incident: IncidentEntity,
): IncidentResponseDto {
  return {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    source: incident.source,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
  };
}

export function toIncidentUpdateResponse(
  entry: IncidentTimelineEntry,
): IncidentUpdateResponseDto {
  return {
    id: entry.id,
    status: entry.status,
    message: entry.message,
    createdAt: entry.createdAt.toISOString(),
  };
}
