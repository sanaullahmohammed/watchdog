import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type TransitionIncidentCommandResult,
  transitionIncidentCommand,
} from './transition-incident.handler';

export default async function transitionIncidentResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      transitionIncident: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<TransitionIncidentCommandResult>(
          transitionIncidentCommand({
            id: args.id,
            status: args.input.status,
            message: args.input.message,
            orgId: context.orgId,
            userId: context.userId,
          }),
        );
      },
    },
  });
}
