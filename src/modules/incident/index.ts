import type { IncidentRepository } from '@/modules/incident/database/incident.repository.port';
import type incidentDomain from '@/modules/incident/domain/incident.domain';
import type incidentMapper from '@/modules/incident/incident.mapper';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    incidentMapper: ReturnType<typeof incidentMapper>;
    incidentRepository: IncidentRepository;
    incidentDomain: ReturnType<typeof incidentDomain>;
  }
}

export const incidentActionCreator = actionCreatorFactory('incident');
