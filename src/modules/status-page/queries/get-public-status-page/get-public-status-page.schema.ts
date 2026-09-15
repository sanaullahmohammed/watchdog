import { type Static, Type } from 'typebox';

/** Field names must match the SDL in `get-public-status-page.graphql-schema.ts`. */
export const publicStatusPageResponseDtoSchema = Type.Object({
  organization: Type.Object({
    name: Type.String(),
    slug: Type.String(),
  }),
});

export type PublicStatusPageResponseDto = Static<
  typeof publicStatusPageResponseDtoSchema
>;
