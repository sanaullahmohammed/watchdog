import { monitoringActionCreator } from '@/modules/monitoring';
import { isLimiterClosed } from '@/modules/monitoring/checks/check-limiter';
import { startMonitorCheck } from '@/modules/monitoring/commands/start-monitor-check';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type QueueDueMonitorChecksCommandResult = Promise<{
  queued: number;
  skipped: number;
}>;

/**
 * The worker's tick for one organization: list the due monitors and queue each
 * one that is not already queued or running, through the limiter keyed by
 * organization. Resolves once queueing is done; the checks finish detached, and
 * a failure is logged with its ids, never left unhandled. ARCHITECTURE 6.0.1.
 * No route or resolver: exposing it would let a caller drive checks.
 */
export const queueDueMonitorChecksCommand = monitoringActionCreator<{
  orgId: string;
  now?: Date;
}>('queue_due_checks');

export default function makeQueueDueMonitorChecks({
  monitorRepository,
  commandBus,
  logger,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof queueDueMonitorChecksCommand
    >): QueueDueMonitorChecksCommandResult {
      const { orgId } = payload;
      const now = payload.now ?? new Date();

      const due = await withTenantTransaction(orgId, (tx) =>
        monitorRepository.listDue(tx, now),
      );

      let queued = 0;
      let skipped = 0;
      for (const monitor of due) {
        const check = startMonitorCheck(
          { monitorRepository, commandBus },
          orgId,
          monitor.id,
          now,
        );
        if (check === null) {
          skipped += 1;
          logger.debug(
            { orgId, monitorId: monitor.id },
            'monitor already queued or running; not queued again',
          );
          continue;
        }
        queued += 1;
        check.catch((error: unknown) => {
          if (isLimiterClosed(error)) {
            // Shutdown dropped a check that never started. It stays due for
            // the next worker, so this is not a failure.
            logger.info(
              { orgId, monitorId: monitor.id },
              'checks not started; worker is shutting down',
            );
            return;
          }
          logger.error(
            { orgId, monitorId: monitor.id, err: error },
            'monitor check failed',
          );
        });
      }
      return { queued, skipped };
    },
    init() {
      commandBus.register(queueDueMonitorChecksCommand.type, this.handler);
    },
  };
}
