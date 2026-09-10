import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type PostIncidentUpdateCommandResult,
  postIncidentUpdateCommand,
} from './post-incident-update.handler';
import { postIncidentUpdateRequestDtoSchema } from './post-incident-update.schema';

export default async function postIncidentUpdate(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/incidents/:id/updates',
    schema: {
      description: 'Append an update to an incident timeline',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: postIncidentUpdateRequestDtoSchema,
      response: { 201: idDtoSchema },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id =
        await fastify.commandBus.execute<PostIncidentUpdateCommandResult>(
          postIncidentUpdateCommand({
            incidentId: req.params.id,
            message: req.body.message,
            orgId: context.orgId,
            userId: context.userId,
          }),
        );

      return res.status(201).send({ id });
    },
  });
}
