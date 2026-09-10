import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ScheduleMaintenanceCommandResult,
  scheduleMaintenanceCommand,
} from './schedule-maintenance.handler';
import { scheduleMaintenanceRequestDtoSchema } from './schedule-maintenance.schema';

export default async function scheduleMaintenance(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/maintenance',
    schema: {
      description: 'Schedule a maintenance window',
      body: scheduleMaintenanceRequestDtoSchema,
      response: { 201: idDtoSchema },
      tags: ['maintenance'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id =
        await fastify.commandBus.execute<ScheduleMaintenanceCommandResult>(
          scheduleMaintenanceCommand({
            ...req.body,
            scheduledStartAt: new Date(req.body.scheduledStartAt),
            scheduledEndAt: new Date(req.body.scheduledEndAt),
            orgId: context.orgId,
            userId: context.userId,
          }),
        );

      return res.status(201).send({ id });
    },
  });
}
