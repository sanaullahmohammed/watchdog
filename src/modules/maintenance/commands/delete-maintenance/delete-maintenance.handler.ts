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
  maintenanceDomain,
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
      // completed instead, so the record of it survives. The window is read
      // first so the refusal can name the status it found; the repository
      // refuses a non-scheduled window too.
      const removed = await withTenantTransaction(payload.orgId, async (tx) => {
        const current = await maintenanceRepository.findById(tx, payload.id);
        if (!current) {
          throw new NotFoundException(`Maintenance ${payload.id} not found`);
        }

        maintenanceDomain.assertDeletable(current.status);

        return maintenanceRepository.remove(tx, payload.id);
      });

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
