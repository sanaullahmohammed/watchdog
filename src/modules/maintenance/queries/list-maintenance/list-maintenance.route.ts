import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { toMaintenanceResponse } from '@/modules/maintenance/dtos/maintenance.present';
import { maintenanceResponseDtoSchema } from '@/modules/maintenance/dtos/maintenance.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type ListMaintenanceQueryResult,
  listMaintenanceQuery,
} from './list-maintenance.handler';
import { listMaintenanceRequestDtoSchema } from './list-maintenance.schema';

export default async function listMaintenance(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/maintenance',
    schema: {
      description: 'List maintenance windows in the active organization',
      querystring: listMaintenanceRequestDtoSchema,
      response: { 200: Type.Array(maintenanceResponseDtoSchema) },
      tags: ['maintenance'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const windows =
        await fastify.queryBus.execute<ListMaintenanceQueryResult>(
          listMaintenanceQuery({ ...req.query, orgId: context.orgId }),
        );

      return res.status(200).send(windows.map(toMaintenanceResponse));
    },
  });
}
