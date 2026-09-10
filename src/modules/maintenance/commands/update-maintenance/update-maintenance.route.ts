import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type UpdateMaintenanceCommandResult,
  updateMaintenanceCommand,
} from './update-maintenance.handler';
import { updateMaintenanceRequestDtoSchema } from './update-maintenance.schema';

export default async function updateMaintenance(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'PATCH',
    url: '/v1/maintenance/:id',
    schema: {
      description: 'Change a scheduled maintenance window',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: updateMaintenanceRequestDtoSchema,
      response: { 200: idDtoSchema },
      tags: ['maintenance'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id =
        await fastify.commandBus.execute<UpdateMaintenanceCommandResult>(
          updateMaintenanceCommand({
            ...req.body,
            scheduledStartAt: req.body.scheduledStartAt
              ? new Date(req.body.scheduledStartAt)
              : undefined,
            scheduledEndAt: req.body.scheduledEndAt
              ? new Date(req.body.scheduledEndAt)
              : undefined,
            id: req.params.id,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send({ id });
    },
  });
}
