import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type CreateMonitorCommandResult,
  createMonitorCommand,
} from './create-monitor.handler';

export default async function createMonitorResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      createMonitor: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<CreateMonitorCommandResult>(
          createMonitorCommand({ ...args.input, orgId: context.orgId }),
        );
      },
    },
  });
}
