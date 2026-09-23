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
  UPTIME_DAY_STATUSES,
  type UptimeDayStatus,
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
const uptimeDayStatus = Type.Unsafe<UptimeDayStatus>(
  Type.String({ enum: [...UPTIME_DAY_STATUSES] }),
);

/** 90 days of history, the window DOMAIN's rollups are sized for. */
export const UPTIME_WINDOW_DAYS = 90;

export const publicStatusPageResponseDtoSchema = Type.Object({
  organization: Type.Object({
    name: Type.String(),
    slug: Type.String(),
  }),
  /**
   * The worst of the visible services' statuses and the listed incidents'
   * headline impact (DOMAIN, "Public status page"), reduced once here so every
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
          /** Written by the operator for customers (DOMAIN, Service). */
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
      /** Visible services only. Empty when the incident names none yet. */
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
      /** Written by the operator for customers (DOMAIN, Maintenance). */
      description: Type.Union([Type.String(), Type.Null()]),
      status: maintenanceStatus,
      scheduledStartAt: Type.String({ format: 'date-time' }),
      scheduledEndAt: Type.String({ format: 'date-time' }),
      startedAt: Type.Union([
        Type.String({ format: 'date-time' }),
        Type.Null(),
      ]),
      /** Visible services only. Empty when the window names none. */
      affectedServiceIds: Type.Array(Type.String({ format: 'uuid' })),
    }),
  ),
  /**
   * Shaped now, filled in Epic 5. `services` is empty until rollups exist, so
   * an integrator can tell "no data yet" from "100% uptime"; the per-day shape
   * is the one DOMAIN's `uptime_rollups` already implies. See DOMAIN, "Public
   * status page", for what a day with no checks carries.
   */
  uptime: Type.Object({
    windowDays: Type.Integer(),
    services: Type.Array(
      Type.Object({
        serviceId: Type.String({ format: 'uuid' }),
        /** One entry per day in the window, oldest first. */
        days: Type.Array(
          Type.Object({
            date: Type.String({ format: 'date' }),
            /** Null on a day the rollups have no row for: no checks ran. */
            uptimeRatio: Type.Union([Type.Number(), Type.Null()]),
            /**
             * The worst a check saw that day, on the rollups' three-level
             * monitor scale, and what colours the day's bar. Null on a day
             * with no checks, like `uptimeRatio`.
             */
            worstStatus: Type.Union([uptimeDayStatus, Type.Null()]),
          }),
        ),
      }),
    ),
  }),
});

export type PublicStatusPageResponseDto = Static<
  typeof publicStatusPageResponseDtoSchema
>;
