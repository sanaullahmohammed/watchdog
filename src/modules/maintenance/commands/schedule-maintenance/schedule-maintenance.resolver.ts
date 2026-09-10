import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ScheduleMaintenanceCommandResult,
  scheduleMaintenanceCommand,
} from './schedule-maintenance.handler';

export default async function scheduleMaintenanceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      scheduleMaintenance: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        return fastify.commandBus.execute<ScheduleMaintenanceCommandResult>(
          scheduleMaintenanceCommand({
            ...args.input,
            scheduledStartAt: new Date(args.input.scheduledStartAt),
            scheduledEndAt: new Date(args.input.scheduledEndAt),
            orgId: context.orgId,
            userId: context.userId,
          }),
        );
      },
    },
  });
}
