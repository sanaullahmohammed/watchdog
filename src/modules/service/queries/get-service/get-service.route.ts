import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { toServiceResponse } from '@/modules/service/dtos/service.present';
import { serviceResponseDtoSchema } from '@/modules/service/dtos/service.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type GetServiceQueryResult,
  getServiceQuery,
} from './get-service.handler';

export default async function getService(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/services/:id',
    schema: {
      description: 'Read one service and its effective status',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: { 200: serviceResponseDtoSchema },
      tags: ['services'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const service = await fastify.queryBus.execute<GetServiceQueryResult>(
        getServiceQuery({ id: req.params.id, orgId: context.orgId }),
      );

      return res.status(200).send(toServiceResponse(service));
    },
  });
}
