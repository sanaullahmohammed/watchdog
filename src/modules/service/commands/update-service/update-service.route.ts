import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type UpdateServiceCommandResult,
  updateServiceCommand,
} from './update-service.handler';
import { updateServiceRequestDtoSchema } from './update-service.schema';

export default async function updateService(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'PATCH',
    url: '/v1/services/:id',
    schema: {
      description: 'Update a service in the active organization',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: updateServiceRequestDtoSchema,
      response: { 200: idDtoSchema },
      tags: ['services'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) {
        throw new UnauthorizedException();
      }

      const id = await fastify.commandBus.execute<UpdateServiceCommandResult>(
        updateServiceCommand({
          ...req.body,
          id: req.params.id,
          orgId: context.orgId,
        }),
      );

      return res.status(200).send({ id });
    },
  });
}
