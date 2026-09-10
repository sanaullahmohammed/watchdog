import { type Static, Type } from 'typebox';
import {
  INCIDENT_STATUSES,
  type IncidentStatus,
} from '@/modules/incident/domain/incident.types';

export const listIncidentsRequestDtoSchema = Type.Object({
  includeDrafts: Type.Optional(
    Type.Boolean({
      description: 'Admin surfaces only; include unconfirmed drafts',
    }),
  ),
  publicOnly: Type.Optional(
    Type.Boolean({
      description: 'Compose a public read; drafts are never returned',
    }),
  ),
  status: Type.Optional(
    Type.Unsafe<IncidentStatus>(Type.String({ enum: [...INCIDENT_STATUSES] })),
  ),
});

export type ListIncidentsRequestDto = Static<
  typeof listIncidentsRequestDtoSchema
>;
