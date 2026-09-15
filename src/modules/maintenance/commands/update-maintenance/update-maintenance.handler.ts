import { maintenanceActionCreator } from '@/modules/maintenance';
import type { UpdateMaintenanceProps } from '@/modules/maintenance/domain/maintenance.types';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { maintenanceUpdatedEvent } from '@/shared/events/maintenance.events';
import { NotFoundException } from '@/shared/exceptions';
import {
  assertNoDuplicates,
  assertNoNullFields,
} from '@/shared/validation/input';

export type UpdateMaintenanceCommandResult = Promise<string>;

export type UpdateMaintenanceCommandPayload = UpdateMaintenanceProps & {
  orgId: string;
  id: string;
  affectedServiceIds?: string[];
};

export const updateMaintenanceCommand =
  maintenanceActionCreator<UpdateMaintenanceCommandPayload>('update');

export default function makeUpdateMaintenance({
  maintenanceRepository,
  maintenanceDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof updateMaintenanceCommand
    >): UpdateMaintenanceCommandResult {
      const { orgId, id, affectedServiceIds, ...patch } = payload;
      // GraphQL cannot express "optional but never null", a format, or a
      // minimum length, so these run here, where both surfaces arrive.
      assertNoNullFields(payload, { nullable: ['description'] });
      assertNoDuplicates(affectedServiceIds ?? [], 'affectedServiceIds');

      const updated = await withTenantTransaction(orgId, async (tx) => {
        const current = await maintenanceRepository.findById(tx, id);
        if (!current) {
          throw new NotFoundException(`Maintenance ${id} not found`);
        }

        // A completed window is history, and a running one accepts only a new
        // end time or a change of affected services. DOMAIN.md, Maintenance
        // state machine; Epic 2 retrospective, R-8.
        maintenanceDomain.assertEditable(current.status, {
          ...patch,
          affectedServiceIds,
        });

        // Moving one end of the window can invert it, so the check is against
        // the window as it will be, not against the fields that were supplied.
        // Done before the write: a CHECK violation aborts the transaction and
        // anything after it, including a read to build a better message.
        maintenanceDomain.assertWindow(
          patch.scheduledStartAt ?? current.scheduledStartAt,
          patch.scheduledEndAt ?? current.scheduledEndAt,
        );

        const window = await maintenanceRepository.update(tx, id, patch);
        if (!window) {
          throw new NotFoundException(`Maintenance ${id} not found`);
        }

        if (affectedServiceIds !== undefined) {
          await maintenanceRepository.replaceAffectedServices(
            tx,
            window,
            affectedServiceIds,
          );
        }

        return window;
      });

      eventBus.emit(
        maintenanceUpdatedEvent({ id: updated.id, orgId: updated.orgId }),
      );

      return updated.id;
    },
    init() {
      commandBus.register(updateMaintenanceCommand.type, this.handler);
    },
  };
}
