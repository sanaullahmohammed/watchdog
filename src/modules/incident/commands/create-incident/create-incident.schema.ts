import { type Static, Type } from 'typebox';
import {
  INCIDENT_IMPACTS,
  type IncidentImpact,
} from '@/modules/incident/domain/incident.types';

const impactSchema = Type.Unsafe<IncidentImpact>(
  Type.String({ enum: [...INCIDENT_IMPACTS] }),
);

/**
 * Field names must match the SDL input in `create-incident.graphql-schema.ts`.
 * `status` is deliberately absent: DOMAIN.md permits exactly one starting
 * status for a declared incident, so it is not the caller's to choose.
 */
export const createIncidentRequestDtoSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  impact: impactSchema,
  startedAt: Type.Optional(Type.String({ format: 'date-time' })),
  affectedServices: Type.Optional(
    Type.Array(
      Type.Object({
        serviceId: Type.String({ format: 'uuid' }),
        impact: impactSchema,
      }),
    ),
  ),
});

export type CreateIncidentRequestDto = Static<
  typeof createIncidentRequestDtoSchema
>;
