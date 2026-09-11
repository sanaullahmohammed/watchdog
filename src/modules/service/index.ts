import type { ServiceRepository } from '@/modules/service/database/service.repository.port';
import type { ServiceGroupRepository } from '@/modules/service/database/service-group.repository.port';
import type serviceStatusRepository from '@/modules/service/database/service-status.repository';
import type serviceDomain from '@/modules/service/domain/service.domain';
import type serviceGroupDomain from '@/modules/service/domain/service-group.domain';
import type serviceMapper from '@/modules/service/service.mapper';
import type serviceGroupMapper from '@/modules/service/service-group.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    serviceMapper: ReturnType<typeof serviceMapper>;
    serviceRepository: ServiceRepository;
    serviceDomain: ReturnType<typeof serviceDomain>;
    serviceGroupMapper: ReturnType<typeof serviceGroupMapper>;
    serviceGroupRepository: ServiceGroupRepository;
    serviceGroupDomain: ReturnType<typeof serviceGroupDomain>;
    serviceStatusRepository: ReturnType<typeof serviceStatusRepository>;
  }
}

export const serviceActionCreator = actionCreatorFactory('service');
