import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { toServiceGroupResponse } from '@/modules/service/dtos/service-group.present';
import { serviceGroupResponseDtoSchema } from '@/modules/service/dtos/service-group.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type GetServiceGroupQueryResult,
  getServiceGroupQuery,
} from './get-service-group.handler';
import { getServiceGroupRequestParamsSchema } from './get-service-group.schema';

export default async function getServiceGroup(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/service-groups/:id',
    schema: {
      description: 'Read one service group',
      params: getServiceGroupRequestParamsSchema,
      response: { 200: serviceGroupResponseDtoSchema },
      tags: ['service-groups'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const group = await fastify.queryBus.execute<GetServiceGroupQueryResult>(
        getServiceGroupQuery({ id: req.params.id, orgId: context.orgId }),
      );

      return res.status(200).send(toServiceGroupResponse(group));
    },
  });
}
