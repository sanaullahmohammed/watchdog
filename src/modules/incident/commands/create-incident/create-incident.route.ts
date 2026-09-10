import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type CreateIncidentCommandResult,
  createIncidentCommand,
} from './create-incident.handler';
import { createIncidentRequestDtoSchema } from './create-incident.schema';

export default async function createIncident(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/incidents',
    schema: {
      description: 'Declare an incident in the active organization',
      body: createIncidentRequestDtoSchema,
      response: { 201: idDtoSchema },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id = await fastify.commandBus.execute<CreateIncidentCommandResult>(
        createIncidentCommand({
          ...req.body,
          startedAt: req.body.startedAt
            ? new Date(req.body.startedAt)
            : undefined,
          orgId: context.orgId,
          userId: context.userId,
        }),
      );

      return res.status(201).send({ id });
    },
  });
}
