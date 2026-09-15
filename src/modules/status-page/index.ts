import type organizationRepository from '@/modules/status-page/database/organization.repository';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    organizationRepository: ReturnType<typeof organizationRepository>;
  }
}

export const statusPageActionCreator = actionCreatorFactory('status_page');
