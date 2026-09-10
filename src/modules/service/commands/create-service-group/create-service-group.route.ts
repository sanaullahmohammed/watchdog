import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { idDtoSchema } from '@/shared/api/id.response.dto';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type CreateServiceGroupCommandResult,
  createServiceGroupCommand,
} from './create-service-group.handler';
import { createServiceGroupRequestDtoSchema } from './create-service-group.schema';

export default async function createServiceGroup(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/v1/service-groups',
    schema: {
      description: 'Create a service group in the active organization',
      body: createServiceGroupRequestDtoSchema,
      response: { 201: idDtoSchema },
      tags: ['service-groups'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const id =
        await fastify.commandBus.execute<CreateServiceGroupCommandResult>(
          createServiceGroupCommand({ ...req.body, orgId: context.orgId }),
        );

      return res.status(201).send({ id });
    },
  });
}
