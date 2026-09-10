import { maintenanceActionCreator } from '@/modules/maintenance';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  maintenanceCompletedEvent,
  maintenanceStartedEvent,
} from '@/shared/events/maintenance.events';

export type TransitionDueMaintenanceCommandResult = Promise<{
  started: number;
  completed: number;
}>;

/**
 * One organization's pass. The worker calls it per tenant; see
 * ARCHITECTURE.md 6.0 for why discovery and work are separate steps.
 *
 * There is no route or resolver. This is the worker's command and exposing it
 * over HTTP would let a caller drive the clock.
 */
export const transitionDueMaintenanceCommand = maintenanceActionCreator<{
  orgId: string;
  now?: Date;
}>('transition_due');

export default function makeTransitionDueMaintenance({
  maintenanceRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof transitionDueMaintenanceCommand
    >): TransitionDueMaintenanceCommandResult {
      const now = payload.now ?? new Date();

      const { started, completed } = await withTenantTransaction(
        payload.orgId,
        async (tx) => {
          // Complete first. A window whose whole span elapsed before any pass
          // ran must land on completed directly rather than being started and
          // completed on consecutive passes, which would announce a start that
          // never happened.
          const completedWindows = await maintenanceRepository.completeDue(
            tx,
            now,
          );
          const startedWindows = await maintenanceRepository.startDue(tx, now);
          return { started: startedWindows, completed: completedWindows };
        },
      );

      // Emitted after the transaction commits, so nothing announces a change
      // that a rollback would have undone.
      for (const window of started) {
        eventBus.emit(
          maintenanceStartedEvent({ id: window.id, orgId: window.orgId }),
        );
      }
      for (const window of completed) {
        eventBus.emit(
          maintenanceCompletedEvent({ id: window.id, orgId: window.orgId }),
        );
      }

      return { started: started.length, completed: completed.length };
    },
    init() {
      commandBus.register(transitionDueMaintenanceCommand.type, this.handler);
    },
  };
}
