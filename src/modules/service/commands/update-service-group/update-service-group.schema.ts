import { type Static, Type } from 'typebox';
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from '@/shared/domain/slug';

export const updateServiceGroupRequestDtoSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  slug: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: SLUG_MAX_LENGTH,
      pattern: SLUG_PATTERN,
    }),
  ),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type UpdateServiceGroupRequestDto = Static<
  typeof updateServiceGroupRequestDtoSchema
>;
