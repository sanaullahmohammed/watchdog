import config from '@/config/env';
import { monitoringActionCreator } from '@/modules/monitoring';
import type { UpdateMonitorProps } from '@/modules/monitoring/domain/monitor.types';
import { assertTargetAllowed } from '@/modules/monitoring/domain/target-safety';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  monitorStateChangedEvent,
  monitorUpdatedEvent,
} from '@/shared/events/monitor.events';
import { NotFoundException } from '@/shared/exceptions';
import {
  assertMatchesSchema,
  assertUuid,
} from '@/shared/validation/typebox-guard';
import { updateMonitorRequestDtoSchema } from './update-monitor.schema';

export type UpdateMonitorCommandResult = Promise<string>;

export type UpdateMonitorCommandPayload = UpdateMonitorProps & {
  orgId: string;
  id: string;
};

export const updateMonitorCommand =
  monitoringActionCreator<UpdateMonitorCommandPayload>('update');

export default function makeUpdateMonitor({
  monitorRepository,
  monitorDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  const notFound = (id: string) =>
    new NotFoundException(`Monitor ${id} not found`);

  return {
    async handler({
      payload,
    }: ReturnType<typeof updateMonitorCommand>): UpdateMonitorCommandResult {
      const { orgId, id, ...patch } = payload;
      assertUuid(id, 'id');
      assertMatchesSchema(updateMonitorRequestDtoSchema, patch);

      // Phase one: a target that differs from the stored one gets the courtesy
      // check, which does DNS and so runs outside any lock. The merged monitor
      // is validated first, so a refusal names every problem. `type` is fixed,
      // so reading the row unlocked is safe; a monitor in another organization
      // is invisible under RLS. Re-sending the stored target skips the check,
      // so an unchanged host that now resolves privately does not block edits.
      if (patch.target !== undefined) {
        const existing = await withTenantTransaction(orgId, (tx) =>
          monitorRepository.findById(tx, id),
        );
        if (!existing) throw notFound(id);
        if (patch.target !== existing.target) {
          monitorDomain.applyUpdate(existing, patch);
          await assertTargetAllowed(existing.type, patch.target, {
            allowedRanges: config.monitor.allowedCidrs,
          });
        }
      }

      // Phase two: lock, merge, validate the merged monitor, write.
      const outcome = await withTenantTransaction(orgId, async (tx) => {
        const current = await monitorRepository.getForUpdate(tx, id);
        if (!current) throw notFound(id);

        const result = monitorDomain.applyUpdate(current, patch);
        if (result.changed) {
          await monitorRepository.update(tx, result.monitor);
        }
        return result;
      });

      const base = {
        orgId: outcome.monitor.orgId,
        monitorId: outcome.monitor.id,
        serviceId: outcome.monitor.serviceId,
        monitorName: outcome.monitor.name,
      };
      if (!outcome.changed) return outcome.monitor.id;
      eventBus.emit(monitorUpdatedEvent(base));
      if (outcome.before !== outcome.after) {
        eventBus.emit(
          monitorStateChangedEvent({
            ...base,
            from: outcome.before,
            to: outcome.after,
            failureEpisode: outcome.monitor.failureEpisode,
          }),
        );
      }

      return outcome.monitor.id;
    },
    init() {
      commandBus.register(updateMonitorCommand.type, this.handler);
    },
  };
}
