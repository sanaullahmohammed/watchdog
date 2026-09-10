import { type Static, Type } from 'typebox';

/**
 * The mutable subset of a service. Every field is optional: an absent key is
 * left alone rather than nulled, so a nullable column can still be cleared
 * deliberately by sending null.
 *
 * Field names must match the SDL input in `update-service.graphql-schema.ts`.
 */
export const updateServiceRequestDtoSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  isPublic: Type.Optional(Type.Boolean()),
  displayOrder: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type UpdateServiceRequestDto = Static<
  typeof updateServiceRequestDtoSchema
>;
