import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { toIncidentDetailResponse } from '@/modules/incident/dtos/incident.present';
import { incidentDetailResponseDtoSchema } from '@/modules/incident/dtos/incident.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type GetIncidentQueryResult,
  getIncidentQuery,
} from './get-incident.handler';
import { getIncidentRequestParamsSchema } from './get-incident.schema';

export default async function getIncident(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/incidents/:id',
    schema: {
      description: 'Read one incident with its affected services',
      params: getIncidentRequestParamsSchema,
      response: { 200: incidentDetailResponseDtoSchema },
      tags: ['incidents'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const incident = await fastify.queryBus.execute<GetIncidentQueryResult>(
        getIncidentQuery({ id: req.params.id, orgId: context.orgId }),
      );

      return res.status(200).send(toIncidentDetailResponse(incident));
    },
  });
}
