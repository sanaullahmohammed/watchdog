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

export const serviceManualOverrideSetEvent =
  serviceEventCreator<ServiceEventPayload>('manual_override_set');

export const serviceManualOverrideClearedEvent =
  serviceEventCreator<ServiceEventPayload>('manual_override_cleared');

export const serviceArchivedEvent =
  serviceEventCreator<ServiceEventPayload>('archived');

export const serviceRestoredEvent =
  serviceEventCreator<ServiceEventPayload>('restored');

/**
 * Public. Effective status moved. Emitted only by the status recomputation
 * handler, and only when the recomputed value differs from the stored one.
 * `from` and `to` are service statuses, typed as strings so `shared` does not
 * import the module's types.
 */
export const serviceStatusChangedEvent = serviceEventCreator<
  ServiceEventPayload & { from: string; to: string }
>('status_changed');

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
