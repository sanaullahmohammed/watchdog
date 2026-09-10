import { ErrorWithProps } from 'mercurius';
import { toMaintenanceResponse } from '@/modules/maintenance/dtos/maintenance.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ListMaintenanceQueryResult,
  listMaintenanceQuery,
} from './list-maintenance.handler';

export default async function listMaintenanceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      maintenanceWindows: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const windows =
          await fastify.queryBus.execute<ListMaintenanceQueryResult>(
            listMaintenanceQuery({
              ...(args.filter ?? {}),
              orgId: context.orgId,
            }),
          );

        return windows.map(toMaintenanceResponse);
      },
    },
  });
}
