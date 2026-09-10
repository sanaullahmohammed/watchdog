import { serviceActionCreator } from '@/modules/service';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceManualOverrideClearedEvent } from '@/shared/events/service.events';
import { NotFoundException } from '@/shared/exceptions';

export type ClearStatusOverrideCommandResult = Promise<boolean>;

export const clearStatusOverrideCommand = serviceActionCreator<{
  orgId: string;
  id: string;
}>('override.clear');

export default function makeClearStatusOverride({
  serviceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof clearStatusOverrideCommand
    >): ClearStatusOverrideCommandResult {
      const { orgId, id } = payload;

      const changed = await withTenantTransaction(orgId, async (tx) => {
        const moved = await serviceRepository.clearManualOverride(tx, id);
        if (moved) return moved;

        const existing = await serviceRepository.findById(tx, id);
        if (!existing) {
          throw new NotFoundException(`Service ${id} not found`);
        }
        return undefined;
      });

      if (!changed) return false;

      // The service returns to computed status by virtue of the override being
      // null; nothing recomputes here. Story 2.16's handler reacts to this
      // event and moves last_known_status if the answer actually changed.
      eventBus.emit(
        serviceManualOverrideClearedEvent({
          id: changed.id,
          orgId: changed.orgId,
          slug: changed.slug,
        }),
      );

      return true;
    },
    init() {
      commandBus.register(clearStatusOverrideCommand.type, this.handler);
    },
  };
}
