import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type UpdateServiceGroupCommandResult,
  updateServiceGroupCommand,
} from './update-service-group.handler';
import { updateServiceGroupRequestDtoSchema } from './update-service-group.schema';

export default async function updateServiceGroup(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'PATCH',
    url: '/v1/service-groups/:id',
    schema: {
      description: 'Update a service group in the active organization',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: updateServiceGroupRequestDtoSchema,
      response: { 200: idDtoSchema },
      tags: ['service-groups'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id =
        await fastify.commandBus.execute<UpdateServiceGroupCommandResult>(
          updateServiceGroupCommand({
            ...req.body,
            id: req.params.id,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send({ id });
    },
  });
}
