import { monitoringActionCreator } from '@/modules/monitoring';

export type MaintainCheckResultPartitionsCommandResult = Promise<{
  created: number;
  dropped: number;
}>;

/**
 * The worker's global partition step: create the coming months, then drop the
 * expired ones. No route or resolver, and no tenant transaction: partitions
 * belong to no organization.
 */
export const maintainCheckResultPartitionsCommand = monitoringActionCreator<{
  retentionDays: number;
}>('maintain_check_result_partitions');

export default function makeMaintainCheckResultPartitions({
  checkResultPartitionRepository,
  commandBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof maintainCheckResultPartitionsCommand
    >): MaintainCheckResultPartitionsCommandResult {
      const created = await checkResultPartitionRepository.createPartitions();
      const dropped = await checkResultPartitionRepository.dropExpired(
        payload.retentionDays,
      );
      return { created, dropped };
    },
    init() {
      commandBus.register(
        maintainCheckResultPartitionsCommand.type,
        this.handler,
      );
    },
  };
}
