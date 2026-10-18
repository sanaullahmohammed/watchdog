import { monitoringActionCreator } from '@/modules/monitoring';
import { startMonitorCheck } from '@/modules/monitoring/commands/start-monitor-check';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type RunDueMonitorChecksCommandResult = Promise<{ checked: number }>;

/**
 * Finds one organization's due monitors, runs each under the process-wide cap
 * and records every outcome, and resolves once they have all settled. The
 * worker queues checks without waiting (queue_due_checks); this awaits its
 * own, and does not await a monitor someone else has registered. No route or
 * resolver: exposing it would let a caller drive checks.
 */
export const runDueMonitorChecksCommand = monitoringActionCreator<{
  orgId: string;
  now?: Date;
}>('run_due_checks');

export default function makeRunDueMonitorChecks({
  monitorRepository,
  commandBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof runDueMonitorChecksCommand
    >): RunDueMonitorChecksCommandResult {
      const { orgId } = payload;
      const now = payload.now ?? new Date();

      // Committed before any check starts: no transaction or connection is
      // held during a network call.
      const due = await withTenantTransaction(orgId, (tx) =>
        monitorRepository.listDue(tx, now),
      );

      const started = due.flatMap((monitor) => {
        const check = startMonitorCheck(
          { monitorRepository, commandBus },
          orgId,
          monitor.id,
          now,
        );
        return check === null ? [] : [check];
      });
      const settled = await Promise.allSettled(started);

      const reasons = settled.flatMap((r) =>
        r.status === 'rejected' ? [r.reason] : [],
      );
      if (reasons.length === 1) throw reasons[0];
      if (reasons.length > 1) {
        throw new AggregateError(
          reasons,
          `${reasons.length} due monitor checks failed`,
        );
      }
      return {
        checked: settled.filter(
          (r) => r.status === 'fulfilled' && r.value === 'recorded',
        ).length,
      };
    },
    init() {
      commandBus.register(runDueMonitorChecksCommand.type, this.handler);
    },
  };
}
