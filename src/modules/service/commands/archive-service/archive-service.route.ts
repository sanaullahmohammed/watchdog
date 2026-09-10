import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ArchiveServiceCommandResult,
  archiveServiceCommand,
} from './archive-service.handler';

export default async function archiveService(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/services/:id/archive',
    schema: {
      description: 'Archive a service in the active organization',
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
        await fastify.commandBus.execute<ArchiveServiceCommandResult>(
          archiveServiceCommand({ id: req.params.id, orgId: context.orgId }),
        );

      return res.status(200).send({ changed });
    },
  });
}
