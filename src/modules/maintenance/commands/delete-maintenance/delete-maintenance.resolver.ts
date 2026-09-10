import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type DeleteMaintenanceCommandResult,
  deleteMaintenanceCommand,
} from './delete-maintenance.handler';

export default async function deleteMaintenanceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      deleteMaintenance: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<DeleteMaintenanceCommandResult>(
          deleteMaintenanceCommand({ id: args.id, orgId: context.orgId }),
        );
      },
    },
  });
}
