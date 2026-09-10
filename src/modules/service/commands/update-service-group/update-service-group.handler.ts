import { serviceActionCreator } from '@/modules/service';
import type { UpdateServiceGroupProps } from '@/modules/service/domain/service-group.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceGroupUpdatedEvent } from '@/shared/events/service.events';
import { NotFoundException } from '@/shared/exceptions';

export type UpdateServiceGroupCommandResult = Promise<string>;

export type UpdateServiceGroupCommandPayload = UpdateServiceGroupProps & {
  orgId: string;
  id: string;
};

export const updateServiceGroupCommand =
  serviceActionCreator<UpdateServiceGroupCommandPayload>('group.update');

export default function makeUpdateServiceGroup({
  serviceGroupRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof updateServiceGroupCommand
    >): UpdateServiceGroupCommandResult {
      const { orgId, id, ...patch } = payload;

      const updated = await withTenantTransaction(orgId, (tx) =>
        serviceGroupRepository.update(tx, id, patch),
      );

      if (!updated) {
        throw new NotFoundException(`Service group ${id} not found`);
      }

      eventBus.emit(
        serviceGroupUpdatedEvent({
          id: updated.id,
          orgId: updated.orgId,
          slug: updated.slug,
        }),
      );

      return updated.id;
    },
    init() {
      commandBus.register(updateServiceGroupCommand.type, this.handler);
    },
  };
}
