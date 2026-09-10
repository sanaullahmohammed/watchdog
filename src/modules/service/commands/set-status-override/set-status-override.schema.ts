import { type Static, Type } from 'typebox';
import {
  SERVICE_STATUSES,
  type ServiceStatus,
} from '@/modules/service/domain/service.types';

/**
 * The ladder is derived from the single source in service.types, so the API
 * cannot drift from the CHECK constraint that also enforces it.
 */
export const setStatusOverrideRequestDtoSchema = Type.Object({
  status: Type.Unsafe<ServiceStatus>(
    Type.String({
      enum: [...SERVICE_STATUSES],
      description: 'Status to display regardless of computed state',
    }),
  ),
});

export type SetStatusOverrideRequestDto = Static<
  typeof setStatusOverrideRequestDtoSchema
>;
