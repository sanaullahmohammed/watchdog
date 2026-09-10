import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ArchiveServiceCommandResult,
  archiveServiceCommand,
} from './archive-service.handler';

export default async function archiveServiceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      archiveService: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<ArchiveServiceCommandResult>(
          archiveServiceCommand({ id: args.id, orgId: context.orgId }),
        );
      },
    },
  });
}
