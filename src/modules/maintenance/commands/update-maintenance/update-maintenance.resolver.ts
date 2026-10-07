import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type UpdateMaintenanceCommandResult,
  updateMaintenanceCommand,
} from './update-maintenance.handler';

export default async function updateMaintenanceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      updateMaintenance: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<UpdateMaintenanceCommandResult>(
          updateMaintenanceCommand({
            ...args.input,
            id: args.id,
            orgId: context.orgId,
          }),
        );
      },
    },
  });
}
