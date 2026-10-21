import type confirmationSendsService from '@/modules/notification/commands/create-subscriber/confirmation-sends.service';
import type organizationBySlugRepository from '@/modules/notification/database/organization-by-slug.repository';
import type subscriberRepository from '@/modules/notification/database/subscriber.repository';
import type { EmailSender } from '@/modules/notification/domain/email-sender.port';
import { actionCreatorFactory } from '@/shared/cqrs/action-creator';

declare global {
  export interface Dependencies {
    /**
     * The SMTP sender, built from `env.email` (story 6.2). Registered in
     * `src/server/di/index.ts`, because its file name matches none of the
     * container's `loadModules` globs.
     */
    emailSender: EmailSender;
    subscriberRepository: ReturnType<typeof subscriberRepository>;
    organizationBySlugRepository: ReturnType<
      typeof organizationBySlugRepository
    >;
    confirmationSendsService: ReturnType<typeof confirmationSendsService>;
  }
}

export const notificationActionCreator = actionCreatorFactory('notification');
