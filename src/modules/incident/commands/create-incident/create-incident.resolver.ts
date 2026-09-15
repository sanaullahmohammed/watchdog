import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { parseOptionalDate } from '@/shared/validation/input';
import {
  type CreateIncidentCommandResult,
  createIncidentCommand,
} from './create-incident.handler';

export default async function createIncidentResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      createIncident: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<CreateIncidentCommandResult>(
          createIncidentCommand({
            ...args.input,
            startedAt: parseOptionalDate(args.input.startedAt, 'startedAt'),
            orgId: context.orgId,
            userId: context.userId,
          }),
        );
      },
    },
  });
}
