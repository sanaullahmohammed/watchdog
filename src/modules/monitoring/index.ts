import type monitorRepository from '@/modules/monitoring/database/monitor.repository';
import type monitorDomain from '@/modules/monitoring/domain/monitor.domain';
import type monitorMapper from '@/modules/monitoring/monitor.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    monitorMapper: ReturnType<typeof monitorMapper>;
    monitorRepository: ReturnType<typeof monitorRepository>;
    monitorDomain: ReturnType<typeof monitorDomain>;
  }
}

export const monitoringActionCreator = actionCreatorFactory('monitor');
