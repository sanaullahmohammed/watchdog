import config from '@/config/env';
import { monitoringActionCreator } from '@/modules/monitoring';
import type { CreateMonitorProps } from '@/modules/monitoring/domain/monitor.types';
import { assertTargetAllowed } from '@/modules/monitoring/domain/target-safety';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { monitorCreatedEvent } from '@/shared/events/monitor.events';
import { assertMatchesSchema } from '@/shared/validation/typebox-guard';
import { createMonitorRequestDtoSchema } from './create-monitor.schema';

export type CreateMonitorCommandResult = Promise<string>;

/**
 * The organization is carried on the command because the CQRS context
 * middleware described in ARCHITECTURE.md 3 does not exist yet. The route and
 * resolver are the only things that set it, from the resolved request context.
 */
export type CreateMonitorCommandPayload = CreateMonitorProps & {
  orgId: string;
};

export const createMonitorCommand =
  monitoringActionCreator<CreateMonitorCommandPayload>('create');

export default function makeCreateMonitor({
  monitorRepository,
  monitorDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof createMonitorCommand>): CreateMonitorCommandResult {
      const { orgId, ...props } = payload;
      assertMatchesSchema(createMonitorRequestDtoSchema, props);
      const monitor = monitorDomain.createMonitor(orgId, props);

      // The courtesy check does DNS, so it runs before any transaction opens.
      await assertTargetAllowed(monitor.type, monitor.target, {
        allowedRanges: config.monitor.allowedCidrs,
      });

      await withTenantTransaction(orgId, async (tx) => {
        await monitorRepository.insert(tx, monitor);
      });

      eventBus.emit(
        monitorCreatedEvent({
          orgId: monitor.orgId,
          monitorId: monitor.id,
          serviceId: monitor.serviceId,
          monitorName: monitor.name,
        }),
      );

      return monitor.id;
    },
    init() {
      commandBus.register(createMonitorCommand.type, this.handler);
    },
  };
}
