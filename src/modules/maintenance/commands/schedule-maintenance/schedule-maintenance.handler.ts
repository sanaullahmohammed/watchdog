import { maintenanceActionCreator } from '@/modules/maintenance';
import type { ScheduleMaintenanceProps } from '@/modules/maintenance/domain/maintenance.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceCreatedEvent } from '@/shared/events/maintenance.events';

export type ScheduleMaintenanceCommandResult = Promise<string>;

export type ScheduleMaintenanceCommandPayload = ScheduleMaintenanceProps & {
  orgId: string;
  userId: string | null;
};

export const scheduleMaintenanceCommand =
  maintenanceActionCreator<ScheduleMaintenanceCommandPayload>('schedule');

export default function makeScheduleMaintenance({
  maintenanceRepository,
  maintenanceDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof scheduleMaintenanceCommand
    >): ScheduleMaintenanceCommandResult {
      const { orgId, userId, ...props } = payload;
      const window = maintenanceDomain.scheduleMaintenance(
        orgId,
        userId,
        props,
      );

      await withTenantTransaction(orgId, (tx) =>
        maintenanceRepository.insert(tx, window),
      );

      eventBus.emit(
        maintenanceCreatedEvent({ id: window.id, orgId: window.orgId }),
      );

      return window.id;
    },
    init() {
      commandBus.register(scheduleMaintenanceCommand.type, this.handler);
    },
  };
}
