import type checkResultPartitionRepository from '@/modules/monitoring/database/check-result-partition.repository';
import type monitorRepository from '@/modules/monitoring/database/monitor.repository';
import type monitorDomain from '@/modules/monitoring/domain/monitor.domain';
import type monitorMapper from '@/modules/monitoring/monitor.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    checkResultPartitionRepository: ReturnType<
      typeof checkResultPartitionRepository
    >;
    monitorMapper: ReturnType<typeof monitorMapper>;
    monitorRepository: ReturnType<typeof monitorRepository>;
    monitorDomain: ReturnType<typeof monitorDomain>;
  }
}

export const monitoringActionCreator = actionCreatorFactory('monitor');
