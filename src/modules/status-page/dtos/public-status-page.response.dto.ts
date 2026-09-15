import { type Static, Type } from 'typebox';
import {
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  type IncidentImpact,
  type IncidentStatus,
  MAINTENANCE_STATUSES,
  type MaintenanceStatus,
  SERVICE_STATUSES,
  type ServiceStatus,
} from '@/shared/domain/status-inputs';

const serviceStatus = Type.Unsafe<ServiceStatus>(
  Type.String({ enum: [...SERVICE_STATUSES] }),
);
const incidentStatus = Type.Unsafe<IncidentStatus>(
  Type.String({ enum: [...INCIDENT_STATUSES] }),
);
const incidentImpact = Type.Unsafe<IncidentImpact>(
  Type.String({ enum: [...INCIDENT_IMPACTS] }),
);
const maintenanceStatus = Type.Unsafe<MaintenanceStatus>(
  Type.String({ enum: [...MAINTENANCE_STATUSES] }),
);

/** 90 days of history, the window DOMAIN's rollups are sized for. */
export const UPTIME_WINDOW_DAYS = 90;

export const publicStatusPageResponseDtoSchema = Type.Object({
  organization: Type.Object({
    name: Type.String(),
    slug: Type.String(),
  }),
  /**
   * The worst of the public services' statuses, reduced once here so every
   * renderer says the same thing rather than each inventing a banner.
   */
  overallStatus: serviceStatus,
  /** When this answer was composed, so a poller can tell one from the next. */
  generatedAt: Type.String({ format: 'date-time' }),
  groups: Type.Array(
    Type.Object({
      // Null for services that belong to no group. That bucket sorts last.
      id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
      name: Type.Union([Type.String(), Type.Null()]),
      displayOrder: Type.Union([Type.Integer(), Type.Null()]),
      services: Type.Array(
        Type.Object({
          id: Type.String({ format: 'uuid' }),
          name: Type.String(),
          slug: Type.String(),
          description: Type.Union([Type.String(), Type.Null()]),
          status: serviceStatus,
          displayOrder: Type.Integer(),
        }),
      ),
    }),
  ),
  activeIncidents: Type.Array(
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      title: Type.String(),
      impact: incidentImpact,
      status: incidentStatus,
      startedAt: Type.String({ format: 'date-time' }),
      affectedServiceIds: Type.Array(Type.String({ format: 'uuid' })),
      /** Oldest first. A renderer showing "latest" reads the end. */
      updates: Type.Array(
        Type.Object({
          id: Type.String({ format: 'uuid' }),
          status: incidentStatus,
          message: Type.String(),
          createdAt: Type.String({ format: 'date-time' }),
        }),
      ),
    }),
  ),
  maintenance: Type.Array(
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      title: Type.String(),
      description: Type.Union([Type.String(), Type.Null()]),
      status: maintenanceStatus,
      scheduledStartAt: Type.String({ format: 'date-time' }),
      scheduledEndAt: Type.String({ format: 'date-time' }),
      startedAt: Type.Union([
        Type.String({ format: 'date-time' }),
        Type.Null(),
      ]),
      affectedServiceIds: Type.Array(Type.String({ format: 'uuid' })),
    }),
  ),
  /**
   * Shaped now, filled in Epic 5. `services` is empty until rollups exist, so
   * an integrator can tell "no data yet" from "100% uptime"; the per-day shape
   * is the one DOMAIN's `uptime_rollups` already implies.
   */
  uptime: Type.Object({
    windowDays: Type.Integer(),
    services: Type.Array(
      Type.Object({
        serviceId: Type.String({ format: 'uuid' }),
        days: Type.Array(
          Type.Object({
            date: Type.String({ format: 'date' }),
            uptimeRatio: Type.Number(),
          }),
        ),
      }),
    ),
  }),
});

export type PublicStatusPageResponseDto = Static<
  typeof publicStatusPageResponseDtoSchema
>;
