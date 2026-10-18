import {
  checkLimiter,
  checkRegistry,
} from '@/modules/monitoring/checks/process-check-limiter';
import { runCheck } from '@/modules/monitoring/checks/run-check';
import { recordCheckResultCommand } from '@/modules/monitoring/commands/record-check-result/record-check-result.handler';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { NotFoundException } from '@/shared/exceptions';

export type MonitorCheckOutcome = 'recorded' | 'skipped';

/**
 * The per-monitor path both commands share. Registers the monitor (so at most
 * one check of it is queued or running in this process), waits for a slot in
 * the limiter keyed by organization, re-reads the monitor in its own
 * transaction with the listing's `now`, runs the check on the fresh row and
 * records the outcome. The id is released on every outcome, including a
 * LimiterClosedError before the task started.
 *
 * Returns null, without doing anything, when the monitor is already
 * registered. Otherwise the promise resolves 'skipped' when the monitor is
 * missing, disabled, archived or no longer due: no result, no event, no error.
 * A record that finds the monitor gone (NotFoundException) is skipped too. Any
 * other rejection propagates and does not count as settled in the registry.
 */
export function startMonitorCheck(
  {
    monitorRepository,
    commandBus,
  }: Pick<Dependencies, 'monitorRepository' | 'commandBus'>,
  orgId: string,
  monitorId: string,
  now: Date,
): Promise<MonitorCheckOutcome> | null {
  return checkRegistry.start(monitorId, () =>
    checkLimiter.run(orgId, async (): Promise<MonitorCheckOutcome> => {
      // Committed before the check starts: no transaction or connection is
      // held during a network call.
      const monitor = await withTenantTransaction(orgId, (tx) =>
        monitorRepository.findRunnable(tx, monitorId, now),
      );
      if (monitor === null) return 'skipped';
      const outcome = await runCheck(monitor);
      try {
        await commandBus.execute(
          recordCheckResultCommand({ orgId, monitorId, outcome }),
        );
      } catch (error) {
        // The monitor was deleted while its check ran: rightly skipped.
        if (error instanceof NotFoundException) return 'skipped';
        throw error;
      }
      return 'recorded';
    }),
  );
}
