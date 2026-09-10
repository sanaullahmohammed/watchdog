import { type Static, Type } from 'typebox';
import {
  SERVICE_STATUSES,
  type ServiceStatus,
} from '@/modules/service/domain/service.types';

/**
 * The status ladder as a schema, derived from the single source in
 * service.types rather than restated. `Type.Unsafe` supplies the static type
 * TypeBox cannot infer from a mapped tuple while keeping `enum` validation.
 */
const serviceStatusSchema = Type.Unsafe<ServiceStatus>(
  Type.String({ enum: [...SERVICE_STATUSES] }),
);

export const serviceResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  serviceGroupId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  name: Type.String(),
  slug: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  manualStatusOverride: Type.Union([serviceStatusSchema, Type.Null()]),
  isPublic: Type.Boolean(),
  displayOrder: Type.Integer(),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  lastKnownStatus: serviceStatusSchema,
});

export type ServiceResponseDto = Static<typeof serviceResponseDtoSchema>;
