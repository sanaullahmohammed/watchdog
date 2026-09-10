import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type UpdateIncidentCommandResult,
  updateIncidentCommand,
} from './update-incident.handler';

export default async function updateIncidentResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      updateIncident: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<UpdateIncidentCommandResult>(
          updateIncidentCommand({
            ...args.input,
            id: args.id,
            orgId: context.orgId,
          }),
        );
      },
    },
  });
}
