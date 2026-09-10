import { ErrorWithProps } from 'mercurius';
import { toMaintenanceResponse } from '@/modules/maintenance/dtos/maintenance.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type GetMaintenanceQueryResult,
  getMaintenanceQuery,
} from './get-maintenance.handler';

export default async function getMaintenanceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      maintenanceWindow: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const window =
          await fastify.queryBus.execute<GetMaintenanceQueryResult>(
            getMaintenanceQuery({ id: args.id, orgId: context.orgId }),
          );

        return toMaintenanceResponse(window);
      },
    },
  });
}
