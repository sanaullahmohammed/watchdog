import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type PostIncidentUpdateCommandResult,
  postIncidentUpdateCommand,
} from './post-incident-update.handler';

export default async function postIncidentUpdateResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      postIncidentUpdate: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<PostIncidentUpdateCommandResult>(
          postIncidentUpdateCommand({
            incidentId: args.id,
            message: args.input.message,
            orgId: context.orgId,
            userId: context.userId,
          }),
        );
      },
    },
  });
}
