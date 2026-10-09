import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { toMonitorResponse } from '@/modules/monitoring/dtos/monitor.present';
import { monitorResponseDtoSchema } from '@/modules/monitoring/dtos/monitor.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ListMonitorsQueryResult,
  listMonitorsQuery,
} from './list-monitors.handler';
import { listMonitorsRequestParamsSchema } from './list-monitors.schema';

export default async function listMonitors(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/services/:serviceId/monitors',
    schema: {
      description: "List a service's monitors, ordered by name then id",
      params: listMonitorsRequestParamsSchema,
      response: { 200: Type.Array(monitorResponseDtoSchema) },
      tags: ['monitors'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const monitors = await fastify.queryBus.execute<ListMonitorsQueryResult>(
        listMonitorsQuery({
          serviceId: req.params.serviceId,
          orgId: context.orgId,
        }),
      );

      return res.status(200).send(monitors.map(toMonitorResponse));
    },
  });
}
