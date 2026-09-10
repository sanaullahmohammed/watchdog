import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/** Incident events from DOMAIN.md's canonical catalog. */
const incidentEventCreator = actionCreatorFactory('incident');

export type IncidentEventPayload = {
  id: string;
  orgId: string;
};

export const incidentCreatedEvent =
  incidentEventCreator<IncidentEventPayload>('created');
