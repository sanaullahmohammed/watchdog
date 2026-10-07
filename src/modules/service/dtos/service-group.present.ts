import type { ServiceGroupEntity } from '@/modules/service/domain/service-group.types';
import type { ServiceGroupResponseDto } from '@/modules/service/dtos/service-group.response.dto';

/**
 * One presenter for both surfaces: the id and the fields a client can edit.
 * Like the admin `Service` type, it leaves out `orgId` and timestamps.
 */
export function toServiceGroupResponse(
  group: ServiceGroupEntity,
): ServiceGroupResponseDto {
  return {
    id: group.id,
    name: group.name,
    slug: group.slug,
    displayOrder: group.displayOrder,
  };
}
