import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type SetStatusOverrideCommandResult,
  setStatusOverrideCommand,
} from './set-status-override.handler';
import { setStatusOverrideRequestDtoSchema } from './set-status-override.schema';

export default async function setStatusOverride(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'PUT',
    url: '/v1/services/:id/status-override',
    schema: {
      description: 'Pin a service status regardless of computed state',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: setStatusOverrideRequestDtoSchema,
      response: {
        200: Type.Object({
          changed: Type.Boolean({
            description: 'False when the override already held this status',
          }),
        }),
      },
      tags: ['services'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const changed =
        await fastify.commandBus.execute<SetStatusOverrideCommandResult>(
          setStatusOverrideCommand({
            id: req.params.id,
            status: req.body.status,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send({ changed });
    },
  });
}
