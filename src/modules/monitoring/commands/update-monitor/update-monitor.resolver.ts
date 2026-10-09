import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type UpdateMonitorCommandResult,
  updateMonitorCommand,
} from './update-monitor.handler';

export default async function updateMonitorResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      updateMonitor: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<UpdateMonitorCommandResult>(
          updateMonitorCommand({
            ...args.input,
            id: args.id,
            orgId: context.orgId,
          }),
        );
      },
    },
  });
}
