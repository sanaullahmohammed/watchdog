import { type Static, Type } from 'typebox';
import type { MonitorType } from '@/modules/monitoring/domain/monitor.types';
import { MONITOR_TYPES } from '@/modules/monitoring/domain/monitor-limits';

export const monitorResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  serviceId: Type.String({ format: 'uuid' }),
  type: Type.Unsafe<MonitorType>(Type.String({ enum: [...MONITOR_TYPES] })),
  name: Type.String(),
  target: Type.String(),
  intervalSeconds: Type.Integer(),
  timeoutSeconds: Type.Integer(),
  failureThreshold: Type.Integer(),
  enabled: Type.Boolean(),
  config: Type.Object({
    keyword: Type.Union([Type.String(), Type.Null()]),
    warnDays: Type.Union([Type.Integer(), Type.Null()]),
  }),
  consecutiveFailures: Type.Integer(),
  lastCheckedAt: Type.Union([
    Type.String({ format: 'date-time' }),
    Type.Null(),
  ]),
});

export type MonitorResponseDto = Static<typeof monitorResponseDtoSchema>;
