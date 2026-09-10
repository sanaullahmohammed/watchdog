import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type GetIncidentTimelineQueryResult,
  getIncidentTimelineQuery,
} from './get-incident-timeline.handler';

export default async function getIncidentTimelineResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      incidentTimeline: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const entries =
          await fastify.queryBus.execute<GetIncidentTimelineQueryResult>(
            getIncidentTimelineQuery({
              incidentId: args.id,
              orgId: context.orgId,
            }),
          );

        return entries.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        }));
      },
    },
  });
}
