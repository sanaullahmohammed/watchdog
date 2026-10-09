import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type UpdateMonitorCommandResult,
  updateMonitorCommand,
} from './update-monitor.handler';
import { updateMonitorRequestDtoSchema } from './update-monitor.schema';

export default async function updateMonitor(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'PATCH',
    url: '/v1/monitors/:id',
    schema: {
      description: 'Update a monitor in the active organization',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: updateMonitorRequestDtoSchema,
      response: { 200: idDtoSchema },
      tags: ['monitors'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) {
        throw new UnauthorizedException();
      }

      const id = await fastify.commandBus.execute<UpdateMonitorCommandResult>(
        updateMonitorCommand({
          ...req.body,
          id: req.params.id,
          orgId: context.orgId,
        }),
      );

      return res.status(200).send({ id });
    },
  });
}
