import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/**
 * Service lifecycle events, from the canonical catalog in DOMAIN.md.
 *
 * Declared in `shared` rather than inside the module because they cross module
 * boundaries: the NOTIFY bridge, the status-page read model and the status
 * recomputation handler all consume them. Payloads are their own types, not
 * re-exports of the module's DTOs.
 */
const serviceEventCreator = actionCreatorFactory('service');

export type ServiceEventPayload = {
  id: string;
  orgId: string;
  slug: string;
};

export const serviceCreatedEvent =
  serviceEventCreator<ServiceEventPayload>('created');

export const serviceUpdatedEvent =
  serviceEventCreator<ServiceEventPayload>('updated');

export type ServiceGroupEventPayload = {
  id: string;
  orgId: string;
  slug: string;
};

const serviceGroupEventCreator = actionCreatorFactory('service_group');

export const serviceGroupCreatedEvent =
  serviceGroupEventCreator<ServiceGroupEventPayload>('created');

export const serviceGroupUpdatedEvent =
  serviceGroupEventCreator<ServiceGroupEventPayload>('updated');

export const serviceGroupDeletedEvent =
  serviceGroupEventCreator<ServiceGroupEventPayload>('deleted');
