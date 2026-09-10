import { serviceActionCreator } from '@/modules/service';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceGroupDeletedEvent } from '@/shared/events/service.events';
import { NotFoundException } from '@/shared/exceptions';

export type DeleteServiceGroupCommandResult = Promise<boolean>;

export const deleteServiceGroupCommand = serviceActionCreator<{
  orgId: string;
  id: string;
}>('group.delete');

export default function makeDeleteServiceGroup({
  serviceGroupRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof deleteServiceGroupCommand
    >): DeleteServiceGroupCommandResult {
      // Services in this group are ungrouped by the foreign key, never deleted.
      const removed = await withTenantTransaction(payload.orgId, (tx) =>
        serviceGroupRepository.remove(tx, payload.id),
      );

      if (!removed) {
        throw new NotFoundException(`Service group ${payload.id} not found`);
      }

      eventBus.emit(
        serviceGroupDeletedEvent({
          id: removed.id,
          orgId: removed.orgId,
          slug: removed.slug,
        }),
      );

      return true;
    },
    init() {
      commandBus.register(deleteServiceGroupCommand.type, this.handler);
    },
  };
}
