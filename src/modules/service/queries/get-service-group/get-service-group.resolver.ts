import { ErrorWithProps } from 'mercurius';
import { toServiceGroupResponse } from '@/modules/service/dtos/service-group.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type GetServiceGroupQueryResult,
  getServiceGroupQuery,
} from './get-service-group.handler';

export default async function getServiceGroupResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      serviceGroup: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const group =
          await fastify.queryBus.execute<GetServiceGroupQueryResult>(
            getServiceGroupQuery({ id: args.id, orgId: context.orgId }),
          );

        return toServiceGroupResponse(group);
      },
    },
  });
}
