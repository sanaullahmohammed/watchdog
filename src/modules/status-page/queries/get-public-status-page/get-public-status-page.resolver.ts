import {
  type GetPublicStatusPageQueryResult,
  getPublicStatusPageQuery,
} from './get-public-status-page.handler';

/**
 * The same public page over GraphQL. No authentication check, for the same
 * reason the REST route has none: the organization comes from the slug.
 */
export default async function getPublicStatusPageResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      publicStatusPage: async (_, args) =>
        fastify.queryBus.execute<GetPublicStatusPageQueryResult>(
          getPublicStatusPageQuery({ slug: args.orgSlug }),
        ),
    },
  });
}
