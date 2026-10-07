import { serviceActionCreator } from '@/modules/service';
import type { ServiceGroupEntity } from '@/modules/service/domain/service-group.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type ListServiceGroupsQueryResult = Promise<ServiceGroupEntity[]>;

export const listServiceGroupsQuery = serviceActionCreator<{
  orgId: string;
}>('group.list');

export default function makeListServiceGroups({
  serviceGroupRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof listServiceGroupsQuery
    >): ListServiceGroupsQueryResult {
      return withTenantTransaction(payload.orgId, (tx) =>
        serviceGroupRepository.list(tx),
      );
    },
    init() {
      queryBus.register(listServiceGroupsQuery.type, this.handler);
    },
  };
}
