import type organizationRepository from '@/modules/status-page/database/organization.repository';
import type publicStatusRepository from '@/modules/status-page/database/public-status.repository';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    organizationRepository: ReturnType<typeof organizationRepository>;
    publicStatusRepository: ReturnType<typeof publicStatusRepository>;
  }
}

export const statusPageActionCreator = actionCreatorFactory('status_page');
