import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type RestoreServiceCommandResult,
  restoreServiceCommand,
} from './restore-service.handler';

export default async function restoreService(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/services/:id/restore',
    schema: {
      description: 'Restore a service in the active organization',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: {
        200: Type.Object({
          changed: Type.Boolean({
            description: 'False when the service was already in this state',
          }),
        }),
      },
      tags: ['services'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const changed =
        await fastify.commandBus.execute<RestoreServiceCommandResult>(
          restoreServiceCommand({ id: req.params.id, orgId: context.orgId }),
        );

      return res.status(200).send({ changed });
    },
  });
}
