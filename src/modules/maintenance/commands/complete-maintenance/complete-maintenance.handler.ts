import { maintenanceActionCreator } from '@/modules/maintenance';
import { assertTransition } from '@/modules/maintenance/domain/maintenance.state-machine';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceCompletedEvent } from '@/shared/events/maintenance.events';
import { NotFoundException } from '@/shared/exceptions';

export type CompleteMaintenanceCommandResult = Promise<boolean>;

export const completeMaintenanceCommand = maintenanceActionCreator<{
  orgId: string;
  id: string;
}>('complete');

export default function makeCompleteMaintenance({
  maintenanceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof completeMaintenanceCommand
    >): CompleteMaintenanceCommandResult {
      const { orgId, id } = payload;

      const completed = await withTenantTransaction(orgId, async (tx) => {
        const current = await maintenanceRepository.findById(tx, id);
        if (!current) {
          throw new NotFoundException(`Maintenance ${id} not found`);
        }

        // Completing an already-completed window is a no-op rather than an
        // error, so the state machine is only consulted when something moves.
        if (current.status === 'completed') {
          return undefined;
        }

        assertTransition(current.status, 'completed');

        return maintenanceRepository.complete(tx, id);
      });

      if (!completed) return false;

      eventBus.emit(
        maintenanceCompletedEvent({
          id: completed.id,
          orgId: completed.orgId,
        }),
      );

      return true;
    },
    init() {
      commandBus.register(completeMaintenanceCommand.type, this.handler);
    },
  };
}
