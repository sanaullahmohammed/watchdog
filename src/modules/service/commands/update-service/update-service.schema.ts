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
  // Assignment to a group. Null detaches. A group in another organization is
  // refused by the composite foreign key, not by a check here.
  serviceGroupId: Type.Optional(
    Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  ),
});

export type UpdateServiceRequestDto = Static<
  typeof updateServiceRequestDtoSchema
>;
