import { maintenanceActionCreator } from '@/modules/maintenance';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceDeletedEvent } from '@/shared/events/maintenance.events';
import { NotFoundException } from '@/shared/exceptions';

export type DeleteMaintenanceCommandResult = Promise<boolean>;

export const deleteMaintenanceCommand = maintenanceActionCreator<{
  orgId: string;
  id: string;
}>('delete');

export default function makeDeleteMaintenance({
  maintenanceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof deleteMaintenanceCommand
    >): DeleteMaintenanceCommandResult {
      // Deletion is for work that never happened. Work that did happen is
      // completed instead, so the record of it survives.
      const removed = await withTenantTransaction(payload.orgId, (tx) =>
        maintenanceRepository.remove(tx, payload.id),
      );

      if (!removed) {
        throw new NotFoundException(`Maintenance ${payload.id} not found`);
      }

      eventBus.emit(
        maintenanceDeletedEvent({ id: removed.id, orgId: removed.orgId }),
      );

      return true;
    },
    init() {
      commandBus.register(deleteMaintenanceCommand.type, this.handler);
    },
  };
}
