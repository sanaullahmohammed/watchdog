import { notificationActionCreator } from '@/modules/notification';
import { hashConfirmationToken } from '@/modules/notification/domain/confirmation-token';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { PUBLIC_PAGE_NOT_FOUND } from '@/shared/domain/public-page-miss';
import { isSlug } from '@/shared/domain/slug';
import { subscriberConfirmedEvent } from '@/shared/events/subscriber.events';
import { NotFoundException } from '@/shared/exceptions';
import { assertMatchesSchema } from '@/shared/validation/typebox-guard';
import { confirmSubscriberRequestDtoSchema } from './confirm-subscriber.schema';

export type ConfirmSubscriberCommandResult = Promise<{ orgName: string }>;

export type ConfirmSubscriberCommandPayload = {
  orgSlug: string;
  token: unknown;
};

export const confirmSubscriberCommand =
  notificationActionCreator<ConfirmSubscriberCommandPayload>(
    'subscriber.confirm',
  );

export default function makeConfirmSubscriber({
  subscriberRepository,
  organizationBySlugRepository,
  commandBus,
  eventBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof confirmSubscriberCommand
    >): ConfirmSubscriberCommandResult {
      const { orgSlug, token } = payload;
      // Neither refusal quotes the token. The route turns them into the
      // uniform answer.
      assertMatchesSchema(confirmSubscriberRequestDtoSchema, { token });
      if (!isSlug(orgSlug)) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
      const org = await organizationBySlugRepository.findBySlug(orgSlug);
      if (!org) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);

      const subscriberId = await withTenantTransaction(org.id, (tx) =>
        subscriberRepository.confirm(
          tx,
          hashConfirmationToken(token as string),
        ),
      );
      if (!subscriberId) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);

      eventBus.emit(subscriberConfirmedEvent({ orgId: org.id, subscriberId }));
      return { orgName: org.name };
    },
    init() {
      commandBus.register(confirmSubscriberCommand.type, this.handler);
    },
  };
}
