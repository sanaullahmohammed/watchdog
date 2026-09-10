import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ListServicesQueryResult,
  listServicesQuery,
} from './list-services.handler';

export default async function listServicesResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      services: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const services =
          await fastify.queryBus.execute<ListServicesQueryResult>(
            listServicesQuery({ ...(args.filter ?? {}), orgId: context.orgId }),
          );

        return services.map((service) => ({
          ...service,
          archivedAt: service.archivedAt?.toISOString() ?? null,
        }));
      },
    },
  });
}
