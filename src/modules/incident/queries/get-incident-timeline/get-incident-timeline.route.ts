import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { incidentUpdateResponseDtoSchema } from '@/modules/incident/dtos/incident.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type GetIncidentTimelineQueryResult,
  getIncidentTimelineQuery,
} from './get-incident-timeline.handler';

export default async function getIncidentTimeline(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/incidents/:id/updates',
    schema: {
      description: 'Read an incident timeline oldest to newest',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: { 200: Type.Array(incidentUpdateResponseDtoSchema) },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const entries =
        await fastify.queryBus.execute<GetIncidentTimelineQueryResult>(
          getIncidentTimelineQuery({
            incidentId: req.params.id,
            orgId: context.orgId,
          }),
        );

      return res.status(200).send(
        entries.map((entry) => ({
          id: entry.id,
          status: entry.status,
          message: entry.message,
          createdAt: entry.createdAt.toISOString(),
        })),
      );
    },
  });
}
