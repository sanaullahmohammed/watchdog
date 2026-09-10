import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type RestoreServiceCommandResult,
  restoreServiceCommand,
} from './restore-service.handler';

export default async function restoreServiceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      restoreService: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<RestoreServiceCommandResult>(
          restoreServiceCommand({ id: args.id, orgId: context.orgId }),
        );
      },
    },
  });
}
