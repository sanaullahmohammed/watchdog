import type { ServiceRepository } from '@/modules/service/database/service.repository.port';
import type serviceDomain from '@/modules/service/domain/service.domain';
import type serviceMapper from '@/modules/service/service.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    serviceMapper: ReturnType<typeof serviceMapper>;
    serviceRepository: ServiceRepository;
    serviceDomain: ReturnType<typeof serviceDomain>;
  }
}

export const serviceActionCreator = actionCreatorFactory('service');
