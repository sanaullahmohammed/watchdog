import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type CreateServiceCommandResult,
  createServiceCommand,
} from './create-service.handler';

export default async function createServiceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      createService: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<CreateServiceCommandResult>(
          createServiceCommand({ ...args.input, orgId: context.orgId }),
        );
      },
    },
  });
}
