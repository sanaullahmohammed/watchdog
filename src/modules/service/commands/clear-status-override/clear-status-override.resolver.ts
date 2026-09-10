import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ClearStatusOverrideCommandResult,
  clearStatusOverrideCommand,
} from './clear-status-override.handler';

export default async function clearStatusOverrideResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      clearServiceStatusOverride: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<ClearStatusOverrideCommandResult>(
          clearStatusOverrideCommand({ id: args.id, orgId: context.orgId }),
        );
      },
    },
  });
}
