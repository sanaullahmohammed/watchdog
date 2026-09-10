import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type CompleteMaintenanceCommandResult,
  completeMaintenanceCommand,
} from './complete-maintenance.handler';

export default async function completeMaintenanceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      completeMaintenance: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<CompleteMaintenanceCommandResult>(
          completeMaintenanceCommand({ id: args.id, orgId: context.orgId }),
        );
      },
    },
  });
}
