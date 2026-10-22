import { env } from '@/config';
import { notificationActionCreator } from '@/modules/notification';
import { verifyUnsubscribe } from '@/modules/notification/domain/unsubscribe-link';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { PUBLIC_PAGE_NOT_FOUND } from '@/shared/domain/public-page-miss';
import { isSlug } from '@/shared/domain/slug';
import { subscriberUnsubscribedEvent } from '@/shared/events/subscriber.events';
import { NotFoundException } from '@/shared/exceptions';
import { assertMatchesSchema } from '@/shared/validation/typebox-guard';
import { unsubscribeRequestDtoSchema } from './unsubscribe.schema';

export type UnsubscribeCommandResult = Promise<{ orgName: string }>;

export type UnsubscribeCommandPayload = {
  orgSlug: string;
  subscriber: unknown;
  signature: unknown;
};

export const unsubscribeCommand =
  notificationActionCreator<UnsubscribeCommandPayload>(
    'subscriber.unsubscribe',
  );

export default function makeUnsubscribe({
  subscriberRepository,
  organizationBySlugRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof unsubscribeCommand>): UnsubscribeCommandResult {
      const { orgSlug, ...request } = payload;
      assertMatchesSchema(unsubscribeRequestDtoSchema, request);
      const subscriberId = request.subscriber as string;
      if (!isSlug(orgSlug)) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
      const org = await organizationBySlugRepository.findBySlug(orgSlug);
      if (!org) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);

      // Before any subscriber SQL.
      if (
        !verifyUnsubscribe(
          env.notificationLinkSecret,
          org.id,
          subscriberId,
          request.signature as string,
        )
      ) {
        throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
      }

      // Also deletes the subscriber's pending deliveries, under the row lock,
      // on both the `unsubscribed` and the `unchanged` outcome (story 6.6).
      const outcome = await withTenantTransaction(org.id, (tx) =>
        subscriberRepository.unsubscribe(tx, subscriberId),
      );
      if (outcome === 'missing')
        throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
      if (outcome === 'unsubscribed') {
        eventBus.emit(
          subscriberUnsubscribedEvent({ orgId: org.id, subscriberId }),
        );
      }
      return { orgName: org.name };
    },
    init() {
      commandBus.register(unsubscribeCommand.type, this.handler);
    },
  };
}
