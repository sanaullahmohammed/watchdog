import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type UpdateServiceGroupCommandResult,
  updateServiceGroupCommand,
} from './update-service-group.handler';

export default async function updateServiceGroupResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      updateServiceGroup: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<UpdateServiceGroupCommandResult>(
          updateServiceGroupCommand({
            ...args.input,
            id: args.id,
            orgId: context.orgId,
          }),
        );
      },
    },
  });
}
