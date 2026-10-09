import { type Static, Type } from 'typebox';
import {
  MONITOR_LIMITS,
  MONITOR_TYPES,
  monitorConfigSchema,
} from '@/modules/monitoring/domain/monitor-limits';

/**
 * The request payload. `orgId` is deliberately absent: the organization comes
 * from the request context, never from the caller.
 *
 * Field names here must match the SDL input in
 * `create-monitor.graphql-schema.ts`; `api-surface-parity.spec.ts` fails the
 * build if they drift. The rules relating fields to each other (timeout below
 * interval, the target's shape for its type, the config keys a type needs) are
 * applied by the monitor domain, in the same message format.
 */
export const createMonitorRequestDtoSchema = Type.Object({
  serviceId: Type.String({
    format: 'uuid',
    description: 'The service this monitor checks',
  }),
  type: Type.Union(
    MONITOR_TYPES.map((type) => Type.Literal(type)),
    { description: 'http, tcp, keyword or ssl_expiry' },
  ),
  name: Type.String({
    example: 'Checkout health',
    minLength: MONITOR_LIMITS.name.min,
    maxLength: MONITOR_LIMITS.name.max,
  }),
  target: Type.String({
    example: 'https://example.com/health',
    description:
      'http and keyword: an absolute http(s) URL; tcp: host:port; ssl_expiry: host or host:port',
    minLength: MONITOR_LIMITS.target.min,
    maxLength: MONITOR_LIMITS.target.max,
  }),
  intervalSeconds: Type.Optional(
    Type.Integer({
      minimum: MONITOR_LIMITS.intervalSeconds.min,
      maximum: MONITOR_LIMITS.intervalSeconds.max,
      description: `Seconds between checks; default ${MONITOR_LIMITS.intervalSeconds.default}`,
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: MONITOR_LIMITS.timeoutSeconds.min,
      maximum: MONITOR_LIMITS.timeoutSeconds.max,
      description: `Must be below intervalSeconds; default ${MONITOR_LIMITS.timeoutSeconds.default}`,
    }),
  ),
  failureThreshold: Type.Optional(
    Type.Integer({
      minimum: MONITOR_LIMITS.failureThreshold.min,
      maximum: MONITOR_LIMITS.failureThreshold.max,
      description: `Consecutive failures before a draft incident; default ${MONITOR_LIMITS.failureThreshold.default}`,
    }),
  ),
  enabled: Type.Optional(Type.Boolean({ description: 'Default true' })),
  config: Type.Optional(monitorConfigSchema),
});

export type CreateMonitorRequestDto = Static<
  typeof createMonitorRequestDtoSchema
>;
