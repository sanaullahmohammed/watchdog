import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type UpdateIncidentCommandResult,
  updateIncidentCommand,
} from './update-incident.handler';
import { updateIncidentRequestDtoSchema } from './update-incident.schema';

export default async function updateIncident(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'PATCH',
    url: '/v1/incidents/:id',
    schema: {
      description: 'Edit an incident without changing its status',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: updateIncidentRequestDtoSchema,
      response: { 200: idDtoSchema },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id = await fastify.commandBus.execute<UpdateIncidentCommandResult>(
        updateIncidentCommand({
          ...req.body,
          id: req.params.id,
          orgId: context.orgId,
        }),
      );

      return res.status(200).send({ id });
    },
  });
}
