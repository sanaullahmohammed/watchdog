import { serviceActionCreator } from '@/modules/service';
import type { ListServicesFilter } from '@/modules/service/database/service.repository.port';
import type { ServiceEntity } from '@/modules/service/domain/service.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type ListServicesQueryResult = Promise<ServiceEntity[]>;

export const listServicesQuery = serviceActionCreator<
  ListServicesFilter & { orgId: string }
>('list');

export default function makeListServices({
  serviceRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof listServicesQuery>): ListServicesQueryResult {
      const { orgId, ...filter } = payload;

      return withTenantTransaction(orgId, (tx) =>
        serviceRepository.list(tx, filter),
      );
    },
    init() {
      queryBus.register(listServicesQuery.type, this.handler);
    },
  };
}
