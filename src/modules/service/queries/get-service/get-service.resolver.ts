import { ErrorWithProps } from 'mercurius';
import { toServiceResponse } from '@/modules/service/dtos/service.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type GetServiceQueryResult,
  getServiceQuery,
} from './get-service.handler';

export default async function getServiceResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      service: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const service = await fastify.queryBus.execute<GetServiceQueryResult>(
          getServiceQuery({ id: args.id, orgId: context.orgId }),
        );

        return toServiceResponse(service);
      },
    },
  });
}
