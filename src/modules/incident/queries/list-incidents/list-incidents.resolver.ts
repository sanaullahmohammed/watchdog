import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ListIncidentsQueryResult,
  listIncidentsQuery,
} from './list-incidents.handler';

export default async function listIncidentsResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      incidents: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const incidents =
          await fastify.queryBus.execute<ListIncidentsQueryResult>(
            listIncidentsQuery({
              ...(args.filter ?? {}),
              orgId: context.orgId,
            }),
          );

        return incidents.map((incident) => ({
          ...incident,
          startedAt: incident.startedAt.toISOString(),
          resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        }));
      },
    },
  });
}
