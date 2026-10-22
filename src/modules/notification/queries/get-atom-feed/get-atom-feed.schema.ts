import { type Static, Type } from 'typebox';

/**
 * The request: one path parameter. REST only, so there is no SDL to match.
 * Deliberately unconstrained, as the page's is: a schema failure answers 400,
 * which would make a malformed slug a different miss from an unknown one. The
 * handler applies the slug rule and answers both with the same 404.
 */
export const getAtomFeedRequestParamsSchema = Type.Object({
  orgSlug: Type.String({
    description:
      'The organization slug. Anything that names no page, malformed or unknown, gets the same 404.',
  }),
});

export type GetAtomFeedRequestParams = Static<
  typeof getAtomFeedRequestParamsSchema
>;
