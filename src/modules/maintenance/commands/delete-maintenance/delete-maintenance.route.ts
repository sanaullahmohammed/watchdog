import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type DeleteMaintenanceCommandResult,
  deleteMaintenanceCommand,
} from './delete-maintenance.handler';

export default async function deleteMaintenance(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'DELETE',
    url: '/v1/maintenance/:id',
    schema: {
      description: 'Remove a window for work that never happened',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: { 204: { type: 'null', description: 'Window removed' } },
      tags: ['maintenance'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      await fastify.commandBus.execute<DeleteMaintenanceCommandResult>(
        deleteMaintenanceCommand({ id: req.params.id, orgId: context.orgId }),
      );

      return res.status(204).send(null);
    },
  });
}
