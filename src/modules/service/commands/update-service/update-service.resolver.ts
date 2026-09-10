import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type UpdateServiceCommandResult,
  updateServiceCommand,
} from './update-service.handler';

export default async function updateServiceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      updateService: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<UpdateServiceCommandResult>(
          updateServiceCommand({
            ...args.input,
            id: args.id,
            orgId: context.orgId,
          }),
        );
      },
    },
  });
}
