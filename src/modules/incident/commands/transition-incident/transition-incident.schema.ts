import { type Static, Type } from 'typebox';
import {
  INCIDENT_STATUSES,
  type IncidentStatus,
} from '@/modules/incident/domain/incident.types';

export const transitionIncidentRequestDtoSchema = Type.Object({
  status: Type.Unsafe<IncidentStatus>(
    Type.String({
      enum: [...INCIDENT_STATUSES],
      description:
        'Target status; the transition must be legal from the current one',
    }),
  ),
});

export type TransitionIncidentRequestDto = Static<
  typeof transitionIncidentRequestDtoSchema
>;
