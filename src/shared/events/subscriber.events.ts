import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

/** Subscriber events from DOMAIN.md's canonical catalog. Admin-only, not bridged. */
const subscriberEventCreator = actionCreatorFactory('subscriber');

/** Ids only: the address never travels in an event. */
export type SubscriberEventPayload = {
  orgId: string;
  subscriberId: string;
};

export const subscriberCreatedEvent =
  subscriberEventCreator<SubscriberEventPayload>('created');
