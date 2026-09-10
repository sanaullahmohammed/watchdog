import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type CreateServiceCommandResult,
  createServiceCommand,
} from './create-service.handler';
import { createServiceRequestDtoSchema } from './create-service.schema';

export default async function createService(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/services',
    schema: {
      description: 'Create a service in the active organization',
      body: createServiceRequestDtoSchema,
      response: { 201: idDtoSchema },
      tags: ['services'],
    },
    handler: async (req, res) => {
      // The organization is resolved here and never read from the body. The
      // general CQRS context middleware in ARCHITECTURE.md 3 is still to come;
      // until it exists, every tenant-scoped route resolves it this way.
      const context = await resolveOrganizationContext(req.headers);
      if (!context) {
        throw new UnauthorizedException();
      }

      const id = await fastify.commandBus.execute<CreateServiceCommandResult>(
        createServiceCommand({ ...req.body, orgId: context.orgId }),
      );

      return res.status(201).send({ id });
    },
  });
}
