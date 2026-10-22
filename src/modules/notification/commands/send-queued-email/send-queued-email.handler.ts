import { env } from '@/config';
import { notificationActionCreator } from '@/modules/notification';
import type { DeliveryRecord } from '@/modules/notification/database/delivery.repository';
import type { NotificationSource } from '@/modules/notification/domain/notification-email';
import { buildNotificationEmail } from '@/modules/notification/domain/notification-email';
import { retryDelaySeconds } from '@/modules/notification/domain/retry-delay';
import { unsubscribeLink } from '@/modules/notification/domain/unsubscribe-link';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  type NotificationDeliveryEventPayload,
  notificationEmailFailedEvent,
  notificationEmailSentEvent,
} from '@/shared/events/notification.events';

export type SendQueuedEmailOutcome =
  | 'none'
  | 'stale'
  | 'dropped'
  | 'sent'
  | 'retrying'
  | 'failed'
  | 'abandoned';

export type SendQueuedEmailCommandResult = Promise<{
  outcome: SendQueuedEmailOutcome;
  /** The sender's diagnostic, for `retrying`, `failed` and `abandoned`. */
  diagnostic?: string;
}>;

/** `last_error` is a diagnostic, not a transcript. */
const LAST_ERROR_MAX = 200;

/**
 * One organization's next owed email: claims the oldest due delivery, sends
 * it with no transaction open, and records the answer. Story 6.7, ARCHITECTURE
 * 5.6. There is no route; the worker's notification pass runs it.
 */
export const sendQueuedEmailCommand = notificationActionCreator<{
  orgId: string;
}>('send_queued_email');

type Leased = {
  event: NotificationDeliveryEventPayload;
  attempts: number;
  to: string;
  orgName: string;
  orgSlug: string;
  source: NotificationSource;
};

type Claim =
  | { kind: 'none' }
  | { kind: 'dropped' }
  | { kind: 'abandoned'; event: NotificationDeliveryEventPayload }
  | ({ kind: 'leased' } & Leased);

export default function makeSendQueuedEmail({
  deliveryRepository,
  subscriberRepository,
  publicHistoryRepository,
  organizationBySlugRepository,
  emailSender,
  commandBus,
  eventBus,
}: Dependencies) {
  const { retryBaseSeconds, retryMaxDelaySeconds, maxAttempts } =
    env.notification;
  const delay = (attempt: number) =>
    retryDelaySeconds(attempt, retryBaseSeconds, retryMaxDelaySeconds);

  return {
    async handler({
      payload,
    }: ReturnType<
      typeof sendQueuedEmailCommand
    >): SendQueuedEmailCommandResult {
      const { orgId } = payload;

      // 1. Claim, in a short transaction. The subscriber and the source are
      // read without a lock: unsubscribe locks the subscriber and then
      // deletes deliveries, so a claim that locked the delivery first and the
      // subscriber second could deadlock with it.
      const claim = await withTenantTransaction<Claim>(orgId, async (tx) => {
        const delivery = await deliveryRepository.claimDue(tx);
        if (!delivery) return { kind: 'none' };

        const event: NotificationDeliveryEventPayload = {
          orgId,
          deliveryId: delivery.id,
          subscriberId: delivery.subscriberId,
          sourceType: delivery.sourceType,
          sourceId: delivery.sourceId,
        };
        const to = await subscriberRepository.confirmedAddress(
          tx,
          delivery.subscriberId,
        );
        const source = await publicHistoryRepository.sourceContent(
          tx,
          delivery.sourceType,
          delivery.sourceId,
        );
        const org = await organizationBySlugRepository.findById(tx, orgId);
        if (to === undefined || source === undefined || org === undefined) {
          await deliveryRepository.drop(tx, delivery.id);
          return { kind: 'dropped' };
        }

        // A crash or a throw after an earlier claim left the row unrecorded.
        if (delivery.attempts >= maxAttempts) {
          await deliveryRepository.abandon(tx, delivery.id);
          return { kind: 'abandoned', event };
        }

        // Leased for this one send: the next pass may claim it only after the
        // wait for the attempt, which exceeds the longest send.
        const attempts = delivery.attempts + 1;
        await deliveryRepository.lease(
          tx,
          delivery.id,
          attempts,
          delay(attempts),
        );
        return {
          kind: 'leased',
          event,
          attempts,
          to,
          orgName: org.name,
          orgSlug: org.slug,
          source,
        };
      });

      if (claim.kind === 'none') return { outcome: 'none' };
      if (claim.kind === 'dropped') return { outcome: 'dropped' };
      if (claim.kind === 'abandoned') {
        eventBus.emit(notificationEmailFailedEvent(claim.event));
        return { outcome: 'abandoned', diagnostic: 'EUNRECORDED' };
      }

      // 2. Send, with no transaction open. `send` never throws.
      const message = buildNotificationEmail({
        to: claim.to,
        orgName: claim.orgName,
        orgSlug: claim.orgSlug,
        publicBaseUrl: env.publicBaseUrl,
        unsubscribeUrl: unsubscribeLink(
          env.publicBaseUrl,
          claim.orgSlug,
          orgId,
          claim.event.subscriberId,
          env.notificationLinkSecret,
        ),
        source: claim.source,
      });
      const result = await emailSender.send(message);

      // 3. Record, guarded by the attempt this claim wrote.
      const id = claim.event.deliveryId;
      const attempts = claim.attempts;
      const recorded = await withTenantTransaction(orgId, async (tx) => {
        const record = (
          outcome: SendQueuedEmailOutcome,
          row: Omit<DeliveryRecord, 'id' | 'attempts'>,
          diagnostic?: string,
        ) =>
          deliveryRepository
            .record(tx, { id, attempts, ...row })
            .then((applied) => ({ applied, outcome, diagnostic }));

        if (result.outcome === 'accepted') {
          return record('sent', {
            status: 'sent',
            retryInSeconds: null,
          });
        }
        const diagnostic = result.diagnostic.slice(0, LAST_ERROR_MAX);
        if (result.outcome === 'permanent') {
          return record(
            'failed',
            { status: 'failed', lastError: diagnostic, retryInSeconds: null },
            diagnostic,
          );
        }
        // Transient. An abandoned send (`EDEADLINE`) may still arrive, so a
        // retry can duplicate it: delivery is at-least-once, accepted
        // (ARCHITECTURE 5.6).
        if (attempts >= maxAttempts) {
          return record(
            'abandoned',
            {
              status: 'abandoned',
              lastError: diagnostic,
              retryInSeconds: null,
            },
            diagnostic,
          );
        }
        return record(
          'retrying',
          {
            status: 'pending',
            lastError: diagnostic,
            retryInSeconds: delay(attempts),
          },
          diagnostic,
        );
      });

      // A stale record changed nothing and announces nothing. Not 'none':
      // the organization may still have rows due.
      if (!recorded.applied) return { outcome: 'stale' };

      if (recorded.outcome === 'sent') {
        eventBus.emit(notificationEmailSentEvent(claim.event));
      } else if (
        recorded.outcome === 'failed' ||
        recorded.outcome === 'abandoned'
      ) {
        eventBus.emit(notificationEmailFailedEvent(claim.event));
      }
      return recorded.diagnostic === undefined
        ? { outcome: recorded.outcome }
        : { outcome: recorded.outcome, diagnostic: recorded.diagnostic };
    },
    init() {
      commandBus.register(sendQueuedEmailCommand.type, this.handler);
    },
  };
}
