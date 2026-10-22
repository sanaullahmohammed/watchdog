import { env } from '@/config';
import {
  confirmedText,
  INVALID_LINK_TEXT,
  linkOnSend,
  sendLinkText,
} from '@/modules/notification/dtos/link-answer';
import {
  ArgumentInvalidException,
  NotFoundException,
} from '@/shared/exceptions';
import {
  type ConfirmSubscriberCommandResult,
  confirmSubscriberCommand,
} from './confirm-subscriber.handler';

/**
 * `GET /status/:orgSlug/subscribers/confirm?token=...` (story 6.4, FR21), the
 * link story 6.3 emails. It acts on GET and answers plain text. Unlike the
 * page it is `no-store` with no validators and has no `OPTIONS`: a link is a
 * navigation, never read cross-origin. A HEAD looks nothing up, so a link
 * scanner's HEAD consumes no token.
 */
export default async function confirmSubscriber(fastify: FastifyRouteInstance) {
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/status/:orgSlug/subscribers/confirm',
    schema: {
      description: 'Confirm a subscription through the emailed link',
      tags: ['public'],
    },
    config: {
      rateLimit: {
        max: env.publicSurface.rateLimit.max,
        timeWindow: env.publicSurface.rateLimit.windowMs,
      },
    },
    onSend: linkOnSend,
    handler: async (req, res) => {
      if (req.method === 'HEAD') return sendLinkText(res, 200, '');
      const { orgSlug } = req.params as { orgSlug: string };
      const { token } = req.query as { token?: unknown };
      try {
        const { orgName } =
          await fastify.commandBus.execute<ConfirmSubscriberCommandResult>(
            confirmSubscriberCommand({ orgSlug, token }),
          );
        return sendLinkText(res, 200, confirmedText(orgName));
      } catch (error) {
        if (
          error instanceof ArgumentInvalidException ||
          error instanceof NotFoundException
        ) {
          return sendLinkText(res, 404, INVALID_LINK_TEXT);
        }
        throw error;
      }
    },
  });
}
