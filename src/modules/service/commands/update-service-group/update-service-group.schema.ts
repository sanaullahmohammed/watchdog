import { type Static, Type } from 'typebox';

export const updateServiceGroupRequestDtoSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  slug: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    }),
  ),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type UpdateServiceGroupRequestDto = Static<
  typeof updateServiceGroupRequestDtoSchema
>;
