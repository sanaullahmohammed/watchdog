import { type Static, Type } from 'typebox';

export const scheduleMaintenanceRequestDtoSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scheduledStartAt: Type.String({ format: 'date-time' }),
  scheduledEndAt: Type.String({ format: 'date-time' }),
  affectedServiceIds: Type.Optional(
    Type.Array(Type.String({ format: 'uuid' })),
  ),
});

export type ScheduleMaintenanceRequestDto = Static<
  typeof scheduleMaintenanceRequestDtoSchema
>;
