import type { MaintenanceRepository } from '@/modules/maintenance/database/maintenance.repository.port';
import type maintenanceDomain from '@/modules/maintenance/domain/maintenance.domain';
import type maintenanceMapper from '@/modules/maintenance/maintenance.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    maintenanceMapper: ReturnType<typeof maintenanceMapper>;
    maintenanceRepository: MaintenanceRepository;
    maintenanceDomain: ReturnType<typeof maintenanceDomain>;
  }
}

export const maintenanceActionCreator = actionCreatorFactory('maintenance');
