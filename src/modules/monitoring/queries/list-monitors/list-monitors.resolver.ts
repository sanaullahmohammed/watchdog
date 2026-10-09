import { ErrorWithProps } from 'mercurius';
import { toMonitorResponse } from '@/modules/monitoring/dtos/monitor.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ListMonitorsQueryResult,
  listMonitorsQuery,
} from './list-monitors.handler';

export default async function listMonitorsResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      monitors: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const monitors =
          await fastify.queryBus.execute<ListMonitorsQueryResult>(
            listMonitorsQuery({
              serviceId: args.serviceId,
              orgId: context.orgId,
            }),
          );

        return monitors.map(toMonitorResponse);
      },
    },
  });
}
