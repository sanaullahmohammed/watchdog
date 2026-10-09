import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type CreateMonitorCommandResult,
  createMonitorCommand,
} from './create-monitor.handler';
import { createMonitorRequestDtoSchema } from './create-monitor.schema';

export default async function createMonitor(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/monitors',
    schema: {
      description: 'Create a monitor for a service in the active organization',
      body: createMonitorRequestDtoSchema,
      response: { 201: idDtoSchema },
      tags: ['monitors'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) {
        throw new UnauthorizedException();
      }

      const id = await fastify.commandBus.execute<CreateMonitorCommandResult>(
        createMonitorCommand({ ...req.body, orgId: context.orgId }),
      );

      return res.status(201).send({ id });
    },
  });
}
