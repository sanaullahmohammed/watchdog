import { serviceActionCreator } from '@/modules/service';
import type { ServiceGroupEntity } from '@/modules/service/domain/service-group.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { NotFoundException } from '@/shared/exceptions';
import { assertUuid } from '@/shared/validation/typebox-guard';

export type GetServiceGroupQueryResult = Promise<ServiceGroupEntity>;

export const getServiceGroupQuery = serviceActionCreator<{
  orgId: string;
  id: string;
}>('group.get');

export default function makeGetServiceGroup({
  serviceGroupRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof getServiceGroupQuery>): GetServiceGroupQueryResult {
      assertUuid(payload.id, 'id');
      const group = await withTenantTransaction(payload.orgId, (tx) =>
        serviceGroupRepository.findById(tx, payload.id),
      );

      // Another organization's group is invisible under RLS, so it is a 404
      // exactly like one that never existed.
      if (!group) {
        throw new NotFoundException(`Service group ${payload.id} not found`);
      }

      return group;
    },
    init() {
      queryBus.register(getServiceGroupQuery.type, this.handler);
    },
  };
}
