import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/** Maintenance events from DOMAIN.md's canonical catalog. */
const maintenanceEventCreator = actionCreatorFactory('maintenance');

export type MaintenanceEventPayload = {
  id: string;
  orgId: string;
};

export const maintenanceCreatedEvent =
  maintenanceEventCreator<MaintenanceEventPayload>('created');

export const maintenanceUpdatedEvent =
  maintenanceEventCreator<MaintenanceEventPayload>('updated');
