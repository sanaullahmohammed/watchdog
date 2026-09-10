import { type Static, Type } from 'typebox';

export const updateMaintenanceRequestDtoSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scheduledStartAt: Type.Optional(Type.String({ format: 'date-time' })),
  scheduledEndAt: Type.Optional(Type.String({ format: 'date-time' })),
  affectedServiceIds: Type.Optional(
    Type.Array(Type.String({ format: 'uuid' })),
  ),
});

export type UpdateMaintenanceRequestDto = Static<
  typeof updateMaintenanceRequestDtoSchema
>;
