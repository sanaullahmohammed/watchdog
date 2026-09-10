import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ClearStatusOverrideCommandResult,
  clearStatusOverrideCommand,
} from './clear-status-override.handler';

export default async function clearStatusOverride(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'DELETE',
    url: '/v1/services/:id/status-override',
    schema: {
      description: 'Return a service to its computed status',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: {
        200: Type.Object({
          changed: Type.Boolean({
            description: 'False when no override was set',
          }),
        }),
      },
      tags: ['services'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const changed =
        await fastify.commandBus.execute<ClearStatusOverrideCommandResult>(
          clearStatusOverrideCommand({
            id: req.params.id,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send({ changed });
    },
  });
}
