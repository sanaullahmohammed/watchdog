import { monitoringActionCreator } from '@/modules/monitoring';
import { checkLimiter } from '@/modules/monitoring/checks/process-check-limiter';
import { runCheck } from '@/modules/monitoring/checks/run-check';
import { recordCheckResultCommand } from '@/modules/monitoring/commands/record-check-result/record-check-result.handler';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type RunDueMonitorChecksCommandResult = Promise<{ checked: number }>;

/**
 * One organization's pass: find the due monitors, run each under the
 * process-wide cap and record every outcome. Story 5.9 wires it into the
 * worker. No route or resolver: exposing it would let a caller drive checks.
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

      const settled = await Promise.allSettled(
        due.map((monitor) =>
          checkLimiter.run(async () => {
            const outcome = await runCheck(monitor);
            await commandBus.execute(
              recordCheckResultCommand({
                orgId,
                monitorId: monitor.id,
                outcome,
              }),
            );
          }),
        ),
      );

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
      return { checked: due.length };
    },
    init() {
      commandBus.register(runDueMonitorChecksCommand.type, this.handler);
    },
  };
}
