import { serviceActionCreator } from '@/modules/service';
import type { ServiceStatus } from '@/modules/service/domain/service.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { serviceManualOverrideSetEvent } from '@/shared/events/service.events';
import { NotFoundException } from '@/shared/exceptions';

export type SetStatusOverrideCommandResult = Promise<boolean>;

export const setStatusOverrideCommand = serviceActionCreator<{
  orgId: string;
  id: string;
  status: ServiceStatus;
}>('override.set');

export default function makeSetStatusOverride({
  serviceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof setStatusOverrideCommand
    >): SetStatusOverrideCommandResult {
      const { orgId, id, status } = payload;

      const changed = await withTenantTransaction(orgId, async (tx) => {
        const moved = await serviceRepository.setManualOverride(tx, id, status);
        if (moved) return moved;

        const existing = await serviceRepository.findById(tx, id);
        if (!existing) {
          throw new NotFoundException(`Service ${id} not found`);
        }
        return undefined;
      });

      if (!changed) return false;

      eventBus.emit(
        serviceManualOverrideSetEvent({
          id: changed.id,
          orgId: changed.orgId,
          slug: changed.slug,
        }),
      );

      return true;
    },
    init() {
      commandBus.register(setStatusOverrideCommand.type, this.handler);
    },
  };
}
