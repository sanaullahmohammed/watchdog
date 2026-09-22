import { type Static, Type } from 'typebox';

/**
 * The request: one path parameter. Its name must match the argument of
 * `publicStatusPage` in `get-public-status-page.graphql-schema.ts`, which the
 * parity contract checks. The response shape lives with the other status-page
 * DTOs, beside the presenter that builds it, and the route imports it from
 * there, as every other route imports its response.
 */
export const getPublicStatusPageRequestParamsSchema = Type.Object({
  // Deliberately unconstrained. A schema failure answers 400, which would make
  // a malformed slug a different miss from an unknown one; the query applies
  // the slug rule and answers both with the same 404.
  orgSlug: Type.String({
    description:
      'The organization slug. Anything that names no page, malformed or unknown, gets the same 404.',
  }),
});

export type GetPublicStatusPageRequestParams = Static<
  typeof getPublicStatusPageRequestParamsSchema
>;
