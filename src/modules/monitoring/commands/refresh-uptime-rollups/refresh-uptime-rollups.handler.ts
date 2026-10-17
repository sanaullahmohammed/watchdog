import { env } from '@/config';
import { monitoringActionCreator } from '@/modules/monitoring';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { uptimeRollupRefreshedEvent } from '@/shared/events/monitor.events';

/** The days retention dropped before they were rolled up, or null. */
export type RefreshUptimeRollupsCommandResult = Promise<{
  from: string;
  to: string;
} | null>;

/**
 * One organization's rollup refresh, run by the worker before partition
 * maintenance (DOMAIN, UptimeRollup, "Which days a refresh covers"). A system
 * command: no route or resolver, and `orgId` comes from the worker's own
 * discovery.
 */
export const refreshUptimeRollupsCommand = monitoringActionCreator<{
  orgId: string;
}>('refresh_uptime_rollups');

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
// YYYY-MM-DD strings order the same as the days they name.
const least = (a: string, b: string) => (a < b ? a : b);
const greatest = (a: string, b: string) => (a > b ? a : b);

export default function makeRefreshUptimeRollups({
  uptimeRollupRepository,
  checkResultPartitionRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof refreshUptimeRollupsCommand
    >): RefreshUptimeRollupsCommandResult {
      const { orgId } = payload;
      // What retention has left, read before the transaction: it is a
      // catalog fact about partitions, not tenant data.
      const retainedFrom = await checkResultPartitionRepository.retainedFrom();

      const outcome = await withTenantTransaction(orgId, async (tx) => {
        const { today, yesterday } = await uptimeRollupRepository.clock(tx);
        const progress = await uptimeRollupRepository.getProgress(tx, orgId);

        // A progress row ahead of yesterday (a clock step) still refreshes
        // yesterday. With none, start at the oldest retained result.
        const from =
          progress !== null
            ? least(addDays(progress, 1), yesterday)
            : ((await uptimeRollupRepository.oldestResultDay(tx, orgId)) ??
              yesterday);

        const lost =
          progress !== null &&
          retainedFrom !== null &&
          addDays(progress, 1) < retainedFrom
            ? {
                from: addDays(progress, 1),
                to: least(addDays(retainedFrom, -1), yesterday),
              }
            : null;

        const written = await uptimeRollupRepository.refresh(
          tx,
          orgId,
          from,
          today,
        );

        const next =
          progress === null ? yesterday : greatest(progress, yesterday);
        if (next !== progress) {
          await uptimeRollupRepository.setProgress(tx, orgId, next);
        }

        const pruned = await uptimeRollupRepository.prune(
          tx,
          orgId,
          today,
          env.monitor.rollupRetentionDays,
        );
        return { from, today, written, pruned, lost };
      });

      if (outcome.written > 0 || outcome.pruned > 0) {
        eventBus.emit(
          uptimeRollupRefreshedEvent({
            orgId,
            from: outcome.from,
            through: outcome.today,
            written: outcome.written,
            pruned: outcome.pruned,
          }),
        );
      }
      return outcome.lost;
    },
    init() {
      commandBus.register(refreshUptimeRollupsCommand.type, this.handler);
    },
  };
}
