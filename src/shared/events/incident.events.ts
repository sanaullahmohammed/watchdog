import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/** Incident events from DOMAIN.md's canonical catalog. */
const incidentEventCreator = actionCreatorFactory('incident');

export type IncidentEventPayload = {
  id: string;
  orgId: string;
};

export const incidentCreatedEvent =
  incidentEventCreator<IncidentEventPayload>('created');

export const incidentUpdatedEvent =
  incidentEventCreator<IncidentEventPayload>('updated');

/** Admin-only. Fires on every legal transition, including into `resolved`. */
export const incidentStateChangedEvent = incidentEventCreator<
  IncidentEventPayload & { from: string; to: string }
>('state_changed');

/** Public. Reserved for incidents that resolved through the public lifecycle. */
export const incidentResolvedEvent =
  incidentEventCreator<IncidentEventPayload>('resolved');

/**
 * Admin-only. A dismissed draft describes an outage that never happened and
 * that customers were never told about, so it must never announce itself as
 * resolved. See ARCHITECTURE.md section 5.4.
 */
export const incidentDismissedEvent =
  incidentEventCreator<IncidentEventPayload>('dismissed');

export const incidentUpdatePostedEvent = incidentEventCreator<
  IncidentEventPayload & { updateId: string }
>('update_posted');
