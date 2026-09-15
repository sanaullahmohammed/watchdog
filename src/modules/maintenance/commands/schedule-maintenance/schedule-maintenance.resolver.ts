import { ErrorWithProps } from 'mercurius';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { parseDate } from '@/shared/validation/input';
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
            scheduledStartAt: parseDate(
              args.input.scheduledStartAt,
              'scheduledStartAt',
            ),
            scheduledEndAt: parseDate(
              args.input.scheduledEndAt,
              'scheduledEndAt',
            ),
            orgId: context.orgId,
            userId: context.userId,
          }),
        );
      },
    },
  });
}
