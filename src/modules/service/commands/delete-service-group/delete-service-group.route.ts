import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type DeleteServiceGroupCommandResult,
  deleteServiceGroupCommand,
} from './delete-service-group.handler';

export default async function deleteServiceGroup(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'DELETE',
    url: '/v1/service-groups/:id',
    schema: {
      description: 'Delete a service group; its services are ungrouped',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: { 204: { type: 'null', description: 'Service group deleted' } },
      tags: ['service-groups'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      await fastify.commandBus.execute<DeleteServiceGroupCommandResult>(
        deleteServiceGroupCommand({ id: req.params.id, orgId: context.orgId }),
      );

      return res.status(204).send(null);
    },
  });
}
