import { type Static, Type } from 'typebox';

/**
 * The request: one path parameter. Its name must match the argument of
 * `publicStatusPage` in `get-public-status-page.graphql-schema.ts`, which the
 * parity contract checks. The response shape lives with the other status-page
 * DTOs, beside the presenter that builds it, and the route imports it from
 * there, as every other route imports its response.
 */
export const getPublicStatusPageRequestParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1 }),
});

export type GetPublicStatusPageRequestParams = Static<
  typeof getPublicStatusPageRequestParamsSchema
>;
