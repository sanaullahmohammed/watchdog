import type { ServiceEntity } from '@/modules/service/domain/service.types';
import type { ServiceResponseDto } from '@/modules/service/dtos/service.response.dto';

/**
 * One presenter for both surfaces, as in the maintenance module. Story 2.18
 * requires REST and GraphQL to return an identical effective status, and the
 * parity contract compares request shapes, not responses; building both
 * responses here is what makes them the same.
 *
 * `lastKnownStatus` is the effective status, kept current by the status
 * recomputation handler. Reading the stored value is the point: no query
 * recomputes across incidents, maintenance and monitor results per request.
 */
export function toServiceResponse(service: ServiceEntity): ServiceResponseDto {
  return {
    id: service.id,
    serviceGroupId: service.serviceGroupId,
    name: service.name,
    slug: service.slug,
    description: service.description,
    manualStatusOverride: service.manualStatusOverride,
    isPublic: service.isPublic,
    displayOrder: service.displayOrder,
    archivedAt: service.archivedAt?.toISOString() ?? null,
    lastKnownStatus: service.lastKnownStatus,
  };
}
