import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type CompleteMaintenanceCommandResult,
  completeMaintenanceCommand,
} from './complete-maintenance.handler';

export default async function completeMaintenance(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/maintenance/:id/complete',
    schema: {
      description:
        'Close out a window: cancel one that will not run, or finish one early',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: {
        200: Type.Object({
          changed: Type.Boolean({
            description: 'False when the window was already completed',
          }),
        }),
      },
      tags: ['maintenance'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const changed =
        await fastify.commandBus.execute<CompleteMaintenanceCommandResult>(
          completeMaintenanceCommand({
            id: req.params.id,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send({ changed });
    },
  });
}
