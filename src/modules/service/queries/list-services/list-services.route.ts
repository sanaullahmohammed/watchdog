import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { serviceResponseDtoSchema } from '@/modules/service/dtos/service.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ListServicesQueryResult,
  listServicesQuery,
} from './list-services.handler';
import { listServicesRequestDtoSchema } from './list-services.schema';

export default async function listServices(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/services',
    schema: {
      description: 'List services in the active organization',
      querystring: listServicesRequestDtoSchema,
      response: { 200: Type.Array(serviceResponseDtoSchema) },
      tags: ['services'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const services = await fastify.queryBus.execute<ListServicesQueryResult>(
        listServicesQuery({ ...req.query, orgId: context.orgId }),
      );

      return res.status(200).send(
        services.map((service) => ({
          id: service.id,
          serviceGroupId: service.serviceGroupId,
          name: service.name,
          slug: service.slug,
          description: service.description,
          manualStatusOverride: service.manualStatusOverride,
          isPublic: service.isPublic,
          displayOrder: service.displayOrder,
          archivedAt: service.archivedAt?.toISOString() ?? null,
          lastKnownStatus: service.lastKnownStatus,
        })),
      );
    },
  });
}
