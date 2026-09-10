import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type CreateServiceGroupCommandResult,
  createServiceGroupCommand,
} from './create-service-group.handler';

export default async function createServiceGroupResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      createServiceGroup: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<CreateServiceGroupCommandResult>(
          createServiceGroupCommand({ ...args.input, orgId: context.orgId }),
        );
      },
    },
  });
}
