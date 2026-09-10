import { type Static, Type } from 'typebox';
import {
  INCIDENT_IMPACTS,
  INCIDENT_SOURCES,
  INCIDENT_STATUSES,
  type IncidentImpact,
  type IncidentSource,
  type IncidentStatus,
} from '@/modules/incident/domain/incident.types';

const statusSchema = Type.Unsafe<IncidentStatus>(
  Type.String({ enum: [...INCIDENT_STATUSES] }),
);

export const incidentResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String(),
  status: statusSchema,
  impact: Type.Unsafe<IncidentImpact>(
    Type.String({ enum: [...INCIDENT_IMPACTS] }),
  ),
  source: Type.Unsafe<IncidentSource>(
    Type.String({ enum: [...INCIDENT_SOURCES] }),
  ),
  startedAt: Type.String({ format: 'date-time' }),
  resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const incidentUpdateResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: statusSchema,
  message: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
});

export type IncidentResponseDto = Static<typeof incidentResponseDtoSchema>;
export type IncidentUpdateResponseDto = Static<
  typeof incidentUpdateResponseDtoSchema
>;
