import { maintenanceActionCreator } from '@/modules/maintenance';
import type { ScheduleMaintenanceProps } from '@/modules/maintenance/domain/maintenance.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceCreatedEvent } from '@/shared/events/maintenance.events';
import {
  assertNoDuplicates,
  assertNoNullFields,
} from '@/shared/validation/input';

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
      // GraphQL cannot express "optional but never null", a format, or a
      // minimum length, so these run here, where both surfaces arrive.
      assertNoNullFields(payload, { nullable: ['description', 'userId'] });
      assertNoDuplicates(props.affectedServiceIds ?? [], 'affectedServiceIds');
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
