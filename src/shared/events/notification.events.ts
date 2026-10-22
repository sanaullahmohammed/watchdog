import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/**
 * Notification events from DOMAIN.md's canonical catalog, emitted once per
 * delivery by the worker's notification pass. Admin-only, not bridged.
 */
const notificationEventCreator = actionCreatorFactory('notification');

/** What a delivery is about. DOMAIN, NotificationDelivery `source_type`. */
export type NotificationSourceType =
  | 'incident_update'
  | 'maintenance_scheduled'
  | 'maintenance_started'
  | 'maintenance_completed';

/** Ids only: the subscriber's address never travels in an event. */
export type NotificationDeliveryEventPayload = {
  orgId: string;
  deliveryId: string;
  subscriberId: string;
  sourceType: NotificationSourceType;
  /** The `incident_updates.id`, or the `maintenance.id`. */
  sourceId: string;
};

/** A `pending` delivery was written to the ledger (story 6.6). */
export const notificationEmailQueuedEvent =
  notificationEventCreator<NotificationDeliveryEventPayload>('email_queued');
