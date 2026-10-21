import { env } from '@/config';
import { notificationActionCreator } from '@/modules/notification';
import { buildConfirmationEmail } from '@/modules/notification/domain/confirmation-email';
import { generateConfirmationToken } from '@/modules/notification/domain/confirmation-token';
import {
  normalizedSubscriberEmailSchema,
  normalizeSubscriberEmail,
} from '@/modules/notification/domain/subscriber-email';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { PUBLIC_PAGE_NOT_FOUND } from '@/shared/domain/public-page-miss';
import { isSlug } from '@/shared/domain/slug';
import { subscriberCreatedEvent } from '@/shared/events/subscriber.events';
import { NotFoundException } from '@/shared/exceptions';
import { assertMatchesSchema } from '@/shared/validation/typebox-guard';
import { createSubscriberRequestDtoSchema } from './create-subscriber.schema';

export type CreateSubscriberCommandResult = Promise<void>;

export type CreateSubscriberCommandPayload = {
  orgSlug: string;
  email: string;
};

export const createSubscriberCommand =
  notificationActionCreator<CreateSubscriberCommandPayload>(
    'subscriber.create',
  );

export default function makeCreateSubscriber({
  subscriberRepository,
  organizationBySlugRepository,
  confirmationSendsService,
  emailSender,
  commandBus,
  eventBus,
  logger,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof createSubscriberCommand
    >): CreateSubscriberCommandResult {
      const { orgSlug, ...request } = payload;
      // The address is checked before the slug is read, so a bad address gets
      // the same 400 for every slug. Neither check quotes the value.
      assertMatchesSchema(createSubscriberRequestDtoSchema, request);
      const email = normalizeSubscriberEmail(request.email);
      assertMatchesSchema(normalizedSubscriberEmailSchema, { email });

      if (!isSlug(orgSlug)) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
      const org = await organizationBySlugRepository.findBySlug(orgSlug);
      if (!org) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);

      const { token, hash } = generateConfirmationToken();
      const result = await withTenantTransaction(org.id, (tx) =>
        subscriberRepository.requestConfirmation(tx, {
          email,
          tokenHash: hash,
          ttlHours: env.subscribe.confirmationTtlHours,
          resendSeconds: env.subscribe.confirmationResendSeconds,
        }),
      );

      if (result.outcome === 'unchanged') return;

      if (result.outcome === 'inserted' || result.outcome === 'returned') {
        eventBus.emit(
          subscriberCreatedEvent({
            orgId: org.id,
            subscriberId: result.subscriberId,
          }),
        );
      }

      // Started, not awaited: the answer takes the same time whether or not an
      // email goes out. The send touches no database.
      const message = buildConfirmationEmail({
        to: email,
        orgName: org.name,
        orgSlug: org.slug,
        token,
        ttlHours: env.subscribe.confirmationTtlHours,
        publicBaseUrl: env.publicBaseUrl,
      });
      confirmationSendsService.track(
        emailSender.send(message).then((sent) => {
          if (sent.outcome !== 'accepted') {
            logger.warn(
              {
                orgId: org.id,
                subscriberId: result.subscriberId,
                diagnostic: sent.diagnostic,
              },
              'confirmation email not sent',
            );
          }
        }),
      );
    },
    init() {
      commandBus.register(createSubscriberCommand.type, this.handler);
    },
  };
}
