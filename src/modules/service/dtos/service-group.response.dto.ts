import { type Static, Type } from 'typebox';

export const serviceGroupResponseDtoSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  slug: Type.String(),
  displayOrder: Type.Integer(),
});

export type ServiceGroupResponseDto = Static<
  typeof serviceGroupResponseDtoSchema
>;
