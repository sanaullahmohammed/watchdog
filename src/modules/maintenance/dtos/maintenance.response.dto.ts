import { type Static, Type } from 'typebox';
import {
  MAINTENANCE_STATUSES,
  type MaintenanceStatus,
} from '@/modules/maintenance/domain/maintenance.types';

const statusSchema = Type.Unsafe<MaintenanceStatus>(
  Type.String({ enum: [...MAINTENANCE_STATUSES] }),
);

export const maintenanceResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  status: statusSchema,
  scheduledStartAt: Type.String({ format: 'date-time' }),
  scheduledEndAt: Type.String({ format: 'date-time' }),
  startedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  affectedServiceIds: Type.Array(Type.String({ format: 'uuid' })),
});

export type MaintenanceResponseDto = Static<
  typeof maintenanceResponseDtoSchema
>;
