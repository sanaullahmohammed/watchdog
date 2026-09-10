import { type Static, Type } from 'typebox';

/**
 * The two exclusion axes, exposed as filters. Field names must match the SDL
 * input in `list-services.graphql-schema.ts`.
 *
 * Defaults are the safe ones: archived services are excluded unless asked for,
 * and `publicOnly` is opt-in so a caller composing a public surface states it
 * rather than inheriting it.
 */
export const listServicesRequestDtoSchema = Type.Object({
  includeArchived: Type.Optional(
    Type.Boolean({
      description: 'Admin surfaces only; include archived services',
    }),
  ),
  publicOnly: Type.Optional(
    Type.Boolean({ description: 'Restrict to services marked is_public' }),
  ),
});

export type ListServicesRequestDto = Static<
  typeof listServicesRequestDtoSchema
>;
