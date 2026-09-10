import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type SetStatusOverrideCommandResult,
  setStatusOverrideCommand,
} from './set-status-override.handler';

export default async function setStatusOverrideResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      setServiceStatusOverride: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<SetStatusOverrideCommandResult>(
          setStatusOverrideCommand({
            id: args.id,
            status: args.input.status,
            orgId: context.orgId,
          }),
        );
      },
    },
  });
}
