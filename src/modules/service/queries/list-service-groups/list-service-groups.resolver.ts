import { ErrorWithProps } from 'mercurius';
import { toServiceGroupResponse } from '@/modules/service/dtos/service-group.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type ListServiceGroupsQueryResult,
  listServiceGroupsQuery,
} from './list-service-groups.handler';

export default async function listServiceGroupsResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      serviceGroups: async (_, _args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const groups =
          await fastify.queryBus.execute<ListServiceGroupsQueryResult>(
            listServiceGroupsQuery({ orgId: context.orgId }),
          );

        return groups.map(toServiceGroupResponse);
      },
    },
  });
}
