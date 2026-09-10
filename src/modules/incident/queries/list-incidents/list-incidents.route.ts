import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { incidentResponseDtoSchema } from '@/modules/incident/dtos/incident.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ListIncidentsQueryResult,
  listIncidentsQuery,
} from './list-incidents.handler';
import { listIncidentsRequestDtoSchema } from './list-incidents.schema';

export default async function listIncidents(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/incidents',
    schema: {
      description: 'List incidents in the active organization',
      querystring: listIncidentsRequestDtoSchema,
      response: { 200: Type.Array(incidentResponseDtoSchema) },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const incidents =
        await fastify.queryBus.execute<ListIncidentsQueryResult>(
          listIncidentsQuery({ ...req.query, orgId: context.orgId }),
        );

      return res.status(200).send(
        incidents.map((incident) => ({
          id: incident.id,
          title: incident.title,
          status: incident.status,
          impact: incident.impact,
          source: incident.source,
          startedAt: incident.startedAt.toISOString(),
          resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        })),
      );
    },
  });
}
