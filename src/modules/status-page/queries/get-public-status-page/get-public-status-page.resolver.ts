import { toPublicStatusPage } from '@/modules/status-page/dtos/public-status-page.present';
import {
  type GetPublicStatusPageQueryResult,
  getPublicStatusPageQuery,
} from './get-public-status-page.handler';

/**
 * The same public page over GraphQL. No authentication check, for the same
 * reason the REST route has none: the organization comes from the slug.
 *
 * Both surfaces present the query's reads through `toPublicStatusPage`, so the
 * two responses are the same object built by the same code, not two shapes kept
 * in step by hand.
 */
export default async function getPublicStatusPageResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      publicStatusPage: async (_, args) => {
        const view =
          await fastify.queryBus.execute<GetPublicStatusPageQueryResult>(
            getPublicStatusPageQuery({ slug: args.orgSlug }),
          );

        return toPublicStatusPage(view);
      },
    },
  });
}
