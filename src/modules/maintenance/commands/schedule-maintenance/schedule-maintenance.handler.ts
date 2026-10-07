import { maintenanceActionCreator } from '@/modules/maintenance';
import type { ScheduleMaintenanceProps } from '@/modules/maintenance/domain/maintenance.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceCreatedEvent } from '@/shared/events/maintenance.events';
import { assertNoDuplicates, parseDate } from '@/shared/validation/input';
import { assertMatchesSchema } from '@/shared/validation/typebox-guard';
import { scheduleMaintenanceRequestDtoSchema } from './schedule-maintenance.schema';

export type ScheduleMaintenanceCommandResult = Promise<string>;

// The dates arrive as the request's strings: the handler checks their format
// against the slice schema before it converts them.
export type ScheduleMaintenanceCommandPayload = Omit<
  ScheduleMaintenanceProps,
  'scheduledStartAt' | 'scheduledEndAt'
> & {
  scheduledStartAt: string;
  scheduledEndAt: string;
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
      const { orgId, userId, ...request } = payload;
      // GraphQL cannot express "optional but never null", a format, or a
      // minimum length, so these run here, where both surfaces arrive.
      assertMatchesSchema(scheduleMaintenanceRequestDtoSchema, request);
      assertNoDuplicates(
        request.affectedServiceIds ?? [],
        'affectedServiceIds',
      );
      const window = maintenanceDomain.scheduleMaintenance(orgId, userId, {
        ...request,
        scheduledStartAt: parseDate(
          request.scheduledStartAt,
          'scheduledStartAt',
        ),
        scheduledEndAt: parseDate(request.scheduledEndAt, 'scheduledEndAt'),
      });

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
