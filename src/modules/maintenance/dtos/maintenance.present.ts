import type { MaintenanceEntity } from '@/modules/maintenance/domain/maintenance.types';
import type { MaintenanceResponseDto } from '@/modules/maintenance/dtos/maintenance.response.dto';

/**
 * One presenter for both surfaces. Written once so the REST route and the
 * GraphQL resolver cannot serialise the same entity differently - the parity
 * contract checks request shapes, not responses.
 */
export function toMaintenanceResponse(
  window: MaintenanceEntity,
): MaintenanceResponseDto {
  return {
    id: window.id,
    title: window.title,
    description: window.description,
    status: window.status,
    scheduledStartAt: window.scheduledStartAt.toISOString(),
    scheduledEndAt: window.scheduledEndAt.toISOString(),
    startedAt: window.startedAt?.toISOString() ?? null,
    completedAt: window.completedAt?.toISOString() ?? null,
    affectedServiceIds: window.affectedServiceIds,
  };
}
