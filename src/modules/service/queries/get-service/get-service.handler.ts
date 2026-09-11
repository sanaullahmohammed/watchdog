import { serviceActionCreator } from '@/modules/service';
import type { ServiceEntity } from '@/modules/service/domain/service.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { NotFoundException } from '@/shared/exceptions';

export type GetServiceQueryResult = Promise<ServiceEntity>;

export const getServiceQuery = serviceActionCreator<{
  orgId: string;
  id: string;
}>('get');

export default function makeGetService({
  serviceRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof getServiceQuery>): GetServiceQueryResult {
      const service = await withTenantTransaction(payload.orgId, (tx) =>
        serviceRepository.findById(tx, payload.id),
      );

      // A service in another organization is invisible under RLS, so it is a
      // 404 exactly like one that never existed.
      //
      // An archived service is still returned. DOMAIN.md keeps archived
      // services off public pages and active lists; a read by id is neither,
      // and it is how an operator finds one to restore. `archivedAt` says so.
      if (!service) {
        throw new NotFoundException(`Service ${payload.id} not found`);
      }

      return service;
    },
    init() {
      queryBus.register(getServiceQuery.type, this.handler);
    },
  };
}
