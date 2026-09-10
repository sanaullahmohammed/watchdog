import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { toMaintenanceResponse } from '@/modules/maintenance/dtos/maintenance.present';
import { maintenanceResponseDtoSchema } from '@/modules/maintenance/dtos/maintenance.response.dto';
import { resolveOrganizationContext } from '@/server/auth/organization-context';
import { UnauthorizedException } from '@/shared/exceptions';
import {
  type GetMaintenanceQueryResult,
  getMaintenanceQuery,
} from './get-maintenance.handler';

export default async function getMaintenance(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/v1/maintenance/:id',
    schema: {
      description: 'Read one maintenance window and its affected services',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      response: { 200: maintenanceResponseDtoSchema },
      tags: ['maintenance'],
    },
    handler: async (req, res) => {
      const context = await resolveOrganizationContext(req.headers);
      if (!context) throw new UnauthorizedException();

      const window = await fastify.queryBus.execute<GetMaintenanceQueryResult>(
        getMaintenanceQuery({ id: req.params.id, orgId: context.orgId }),
      );

      return res.status(200).send(toMaintenanceResponse(window));
    },
  });
}
