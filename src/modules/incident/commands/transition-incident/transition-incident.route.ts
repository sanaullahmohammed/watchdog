import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type TransitionIncidentCommandResult,
  transitionIncidentCommand,
} from './transition-incident.handler';
import { transitionIncidentRequestDtoSchema } from './transition-incident.schema';

export default async function transitionIncident(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/incidents/:id/transition',
    schema: {
      description: 'Advance an incident along its lifecycle',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: transitionIncidentRequestDtoSchema,
      response: { 200: idDtoSchema },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id =
        await fastify.commandBus.execute<TransitionIncidentCommandResult>(
          transitionIncidentCommand({
            id: req.params.id,
            status: req.body.status,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send({ id });
    },
  });
}
