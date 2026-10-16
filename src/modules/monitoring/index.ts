import type checkResultRepository from '@/modules/monitoring/database/check-result.repository';
import type checkResultPartitionRepository from '@/modules/monitoring/database/check-result-partition.repository';
import type monitorRepository from '@/modules/monitoring/database/monitor.repository';
import type monitorSslWarningRepository from '@/modules/monitoring/database/monitor-ssl-warning.repository';
import type monitorDomain from '@/modules/monitoring/domain/monitor.domain';
import type monitorMapper from '@/modules/monitoring/monitor.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    checkResultPartitionRepository: ReturnType<
      typeof checkResultPartitionRepository
    >;
    checkResultRepository: ReturnType<typeof checkResultRepository>;
    monitorMapper: ReturnType<typeof monitorMapper>;
    monitorRepository: ReturnType<typeof monitorRepository>;
    monitorSslWarningRepository: ReturnType<typeof monitorSslWarningRepository>;
    monitorDomain: ReturnType<typeof monitorDomain>;
  }
}

export const monitoringActionCreator = actionCreatorFactory('monitor');
