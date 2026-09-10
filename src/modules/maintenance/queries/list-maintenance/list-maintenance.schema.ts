import { type Static, Type } from 'typebox';
import {
  MAINTENANCE_STATUSES,
  type MaintenanceStatus,
} from '@/modules/maintenance/domain/maintenance.types';

export const listMaintenanceRequestDtoSchema = Type.Object({
  status: Type.Optional(
    Type.Unsafe<MaintenanceStatus>(
      Type.String({ enum: [...MAINTENANCE_STATUSES] }),
    ),
  ),
});

export type ListMaintenanceRequestDto = Static<
  typeof listMaintenanceRequestDtoSchema
>;
