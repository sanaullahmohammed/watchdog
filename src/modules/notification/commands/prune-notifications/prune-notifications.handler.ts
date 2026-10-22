import { env } from '@/config';
import { notificationActionCreator } from '@/modules/notification';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

export type PruneNotificationsCommandResult = Promise<{
  /** Deliveries the retention rule deleted; a deleted subscriber's go by cascade, uncounted. */
  deliveries: number;
  unsubscribed: number;
  neverConfirmed: number;
}>;

/**
 * One organization's retention prune (story 6.9; DOMAIN, Subscriber "Never
 * confirmed" and NotificationDelivery "Retention"). Deletes final deliveries
 * and unsubscribed subscribers past `NOTIFICATION_RETENTION_DAYS`, and pending
 * subscribers whose token expired more than `SUBSCRIBER_PENDING_GRACE_DAYS`
 * ago. Each rule is one `delete` that holds the whole rule.
 *
 * `deliveries` counts only rows the delivery rule deleted. The deliveries of a
 * deleted subscriber go by the foreign key's cascade and are not counted.
 *
 * There is no route or resolver, and no event: this is the worker's command.
 */
export const pruneNotificationsCommand = notificationActionCreator<{
  orgId: string;
}>('prune_notifications');

export default function makePruneNotifications({
  deliveryRepository,
  subscriberRepository,
  commandBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof pruneNotificationsCommand
    >): PruneNotificationsCommandResult {
      return withTenantTransaction(payload.orgId, async (tx) => ({
        deliveries: await deliveryRepository.pruneFinal(
          tx,
          env.notification.retentionDays,
          env.notification.cursorOverlapSeconds,
        ),
        unsubscribed: await subscriberRepository.pruneUnsubscribed(
          tx,
          env.notification.retentionDays,
        ),
        neverConfirmed: await subscriberRepository.pruneNeverConfirmed(
          tx,
          env.subscribe.pendingGraceDays,
        ),
      }));
    },
    init() {
      commandBus.register(pruneNotificationsCommand.type, this.handler);
    },
  };
}
