import { type Static, Type } from 'typebox';
import {
  MONITOR_LIMITS,
  monitorConfigSchema,
} from '@/modules/monitoring/domain/monitor-limits';

/**
 * The mutable subset of a monitor. Every field is optional: an absent key is
 * left alone. `type` and `serviceId` are fixed at creation and absent here.
 * `config`, when sent, replaces the stored object whole.
 *
 * Field names must match the SDL input in `update-monitor.graphql-schema.ts`.
 */
export const updateMonitorRequestDtoSchema = Type.Object({
  name: Type.Optional(
    Type.String({
      minLength: MONITOR_LIMITS.name.min,
      maxLength: MONITOR_LIMITS.name.max,
    }),
  ),
  target: Type.Optional(
    Type.String({
      minLength: MONITOR_LIMITS.target.min,
      maxLength: MONITOR_LIMITS.target.max,
    }),
  ),
  intervalSeconds: Type.Optional(
    Type.Integer({
      minimum: MONITOR_LIMITS.intervalSeconds.min,
      maximum: MONITOR_LIMITS.intervalSeconds.max,
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: MONITOR_LIMITS.timeoutSeconds.min,
      maximum: MONITOR_LIMITS.timeoutSeconds.max,
    }),
  ),
  failureThreshold: Type.Optional(
    Type.Integer({
      minimum: MONITOR_LIMITS.failureThreshold.min,
      maximum: MONITOR_LIMITS.failureThreshold.max,
    }),
  ),
  enabled: Type.Optional(Type.Boolean()),
  config: Type.Optional(monitorConfigSchema),
});

export type UpdateMonitorRequestDto = Static<
  typeof updateMonitorRequestDtoSchema
>;
