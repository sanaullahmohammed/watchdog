import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type DeleteServiceGroupCommandResult,
  deleteServiceGroupCommand,
} from './delete-service-group.handler';

export default async function deleteServiceGroupResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      deleteServiceGroup: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<DeleteServiceGroupCommandResult>(
          deleteServiceGroupCommand({ id: args.id, orgId: context.orgId }),
        );
      },
    },
  });
}
