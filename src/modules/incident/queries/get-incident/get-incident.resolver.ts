import { ErrorWithProps } from 'mercurius';
import { toIncidentDetailResponse } from '@/modules/incident/dtos/incident.present';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import {
  type GetIncidentQueryResult,
  getIncidentQuery,
} from './get-incident.handler';

export default async function getIncidentResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Query: {
      incident: async (_, args, ctx) => {
        const context = await resolveOrganizationContext(
          ctx.reply.request.headers,
        );
        if (!context) {
          throw new ErrorWithProps('Authentication required', {
            code: 'UNAUTHENTICATED',
          });
        }

        const incident = await fastify.queryBus.execute<GetIncidentQueryResult>(
          getIncidentQuery({ id: args.id, orgId: context.orgId }),
        );

        return toIncidentDetailResponse(incident);
      },
    },
  });
}
