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

const impactSchema = Type.Unsafe<IncidentImpact>(
  Type.String({ enum: [...INCIDENT_IMPACTS] }),
);

export const incidentResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String(),
  status: statusSchema,
  impact: impactSchema,
  source: Type.Unsafe<IncidentSource>(
    Type.String({ enum: [...INCIDENT_SOURCES] }),
  ),
  startedAt: Type.String({ format: 'date-time' }),
  resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

/** The admin detail: the incident plus the services it names. */
export const incidentDetailResponseDtoSchema = Type.Object({
  ...incidentResponseDtoSchema.properties,
  affectedServices: Type.Array(
    Type.Object({
      serviceId: Type.String({ format: 'uuid' }),
      impact: impactSchema,
    }),
  ),
});

export const incidentUpdateResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: statusSchema,
  message: Type.String(),
  createdAt: Type.String({ format: 'date-time' }),
});

export type IncidentResponseDto = Static<typeof incidentResponseDtoSchema>;
export type IncidentDetailResponseDto = Static<
  typeof incidentDetailResponseDtoSchema
>;
export type IncidentUpdateResponseDto = Static<
  typeof incidentUpdateResponseDtoSchema
>;
