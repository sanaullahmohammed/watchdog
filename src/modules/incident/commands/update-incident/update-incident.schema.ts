import { type Static, Type } from 'typebox';
import {
  INCIDENT_IMPACTS,
  type IncidentImpact,
} from '@/modules/incident/domain/incident.types';

const impactSchema = Type.Unsafe<IncidentImpact>(
  Type.String({ enum: [...INCIDENT_IMPACTS] }),
);

/**
 * Edits that carry no status change. `status` is absent on purpose: moving an
 * incident along its lifecycle goes through the transition command, where the
 * state machine decides legality, and announces a different event.
 */
export const updateIncidentRequestDtoSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  impact: Type.Optional(impactSchema),
  affectedServices: Type.Optional(
    Type.Array(
      Type.Object({
        serviceId: Type.String({ format: 'uuid' }),
        impact: impactSchema,
      }),
    ),
  ),
});

export type UpdateIncidentRequestDto = Static<
  typeof updateIncidentRequestDtoSchema
>;
