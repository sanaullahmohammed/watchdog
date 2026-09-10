import { type Static, Type } from 'typebox';

export const createServiceGroupRequestDtoSchema = Type.Object({
  name: Type.String({ example: 'Payments', minLength: 1, maxLength: 120 }),
  slug: Type.String({
    example: 'payments',
    minLength: 1,
    maxLength: 120,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  }),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type CreateServiceGroupRequestDto = Static<
  typeof createServiceGroupRequestDtoSchema
>;
