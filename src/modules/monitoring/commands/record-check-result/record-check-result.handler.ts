import { monitoringActionCreator } from '@/modules/monitoring';
import {
  type CheckOutcome,
  truncateMessage,
} from '@/modules/monitoring/checks/check-outcome';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  monitorCheckFailedEvent,
  monitorCheckSucceededEvent,
  monitorRecoveredEvent,
  monitorStateChangedEvent,
  monitorThresholdBreachedEvent,
} from '@/shared/events/monitor.events';
import { NotFoundException } from '@/shared/exceptions';
import { assertUuid } from '@/shared/validation/typebox-guard';

export type RecordCheckResultCommandResult = Promise<string>;

/**
 * A system command: no route or resolver. `outcome` is typed input from the
 * check adapters and is trusted; only `monitorId` is guarded.
 */
export type RecordCheckResultCommandPayload = {
  orgId: string;
  monitorId: string;
  outcome: CheckOutcome<object>;
};

export const recordCheckResultCommand =
  monitoringActionCreator<RecordCheckResultCommandPayload>(
    'record_check_result',
  );

export default function makeRecordCheckResult({
  monitorRepository,
  checkResultRepository,
  monitorDomain,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof recordCheckResultCommand
    >): RecordCheckResultCommandResult {
      const { orgId, monitorId, outcome } = payload;
      assertUuid(monitorId, 'monitorId');

      const result = await withTenantTransaction(orgId, async (tx) => {
        const current = await monitorRepository.getForUpdate(tx, monitorId);
        if (!current) {
          throw new NotFoundException(`Monitor ${monitorId} not found`);
        }

        const resultId = await checkResultRepository.append(tx, {
          orgId,
          monitorId,
          serviceId: current.serviceId,
          checkedAt: outcome.checkedAt,
          status: outcome.status,
          latencyMs: outcome.latencyMs,
          errorCode: outcome.errorCode,
          errorMessage:
            outcome.errorMessage === null
              ? null
              : truncateMessage(outcome.errorMessage),
          metadata: outcome.metadata,
        });

        const applied = monitorDomain.applyCheck(
          current,
          outcome.status,
          outcome.checkedAt,
        );
        if (applied.counted) {
          await monitorRepository.recordCheck(tx, monitorId, {
            consecutiveFailures: applied.monitor.consecutiveFailures,
            failureEpisode: applied.monitor.failureEpisode,
            lastCheckedAt: outcome.checkedAt,
          });
        }
        return { resultId, current, ...applied };
      });

      const { current, monitor, before, after } = result;
      const base = {
        orgId,
        monitorId,
        serviceId: current.serviceId,
        monitorName: current.name,
      };
      const checkedAt = outcome.checkedAt.toISOString();
      eventBus.emit(
        outcome.status === 'success'
          ? monitorCheckSucceededEvent({ ...base, checkedAt })
          : monitorCheckFailedEvent({
              ...base,
              checkedAt,
              errorCode: outcome.errorCode,
            }),
      );

      if (before !== after) {
        eventBus.emit(
          monitorStateChangedEvent({
            ...base,
            from: before,
            to: after,
            failureEpisode: monitor.failureEpisode,
          }),
        );
        if (after === 'failing') {
          eventBus.emit(
            monitorThresholdBreachedEvent({
              ...base,
              failureEpisode: monitor.failureEpisode,
            }),
          );
        }
        if (before === 'failing' && after === 'healthy') {
          eventBus.emit(
            monitorRecoveredEvent({
              ...base,
              failureEpisode: monitor.failureEpisode,
            }),
          );
        }
      }
      return result.resultId;
    },
    init() {
      commandBus.register(recordCheckResultCommand.type, this.handler);
    },
  };
}
