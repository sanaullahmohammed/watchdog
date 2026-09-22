import { type Static, Type } from 'typebox';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '@/shared/domain/slug';

export const createServiceGroupRequestDtoSchema = Type.Object({
  name: Type.String({ example: 'Payments', minLength: 1, maxLength: 120 }),
  slug: Type.String({
    example: 'payments',
    minLength: 1,
    maxLength: SLUG_MAX_LENGTH,
    pattern: SLUG_PATTERN,
  }),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type CreateServiceGroupRequestDto = Static<
  typeof createServiceGroupRequestDtoSchema
>;
