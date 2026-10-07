import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { toServiceGroupResponse } from '@/modules/service/dtos/service-group.present';
import { serviceGroupResponseDtoSchema } from '@/modules/service/dtos/service-group.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ListServiceGroupsQueryResult,
  listServiceGroupsQuery,
} from './list-service-groups.handler';

export default async function listServiceGroups(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/service-groups',
    schema: {
      description: 'List service groups in the active organization',
      response: { 200: Type.Array(serviceGroupResponseDtoSchema) },
      tags: ['service-groups'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const groups =
        await fastify.queryBus.execute<ListServiceGroupsQueryResult>(
          listServiceGroupsQuery({ orgId: context.orgId }),
        );

      return res.status(200).send(groups.map(toServiceGroupResponse));
    },
  });
}
