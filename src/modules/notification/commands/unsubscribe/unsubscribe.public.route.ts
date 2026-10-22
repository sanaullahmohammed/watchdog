import { env } from '@/config';
import {
  INVALID_LINK_TEXT,
  linkOnSend,
  sendLinkText,
  unsubscribedText,
} from '@/modules/notification/dtos/link-answer';
import {
  ArgumentInvalidException,
  NotFoundException,
} from '@/shared/exceptions';
import {
  type UnsubscribeCommandResult,
  unsubscribeCommand,
} from './unsubscribe.handler';

/**
 * `GET` and `POST /status/:orgSlug/subscribers/unsubscribe?subscriber=...&signature=...`
 * (story 6.4, FR21). The POST is RFC 8058's one-click form: a mail server posts
 * `List-Unsubscribe=One-Click` to the same URL. The signed query string is the
 * authority, so the body is read (to a 1 KiB bound) and ignored, whatever its
 * content type. Same bounds as the confirm link: `no-store`, no validators, no
 * `OPTIONS`. A HEAD looks nothing up.
 */
export default async function unsubscribe(fastify: FastifyRouteInstance) {
  // Encapsulated: this plugin's parsers alone are replaced. Any content type,
  // or none, is accepted and discarded.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    '*',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, _body, done) => {
      done(null, undefined);
    },
  );

  const config = {
    rateLimit: {
      max: env.publicSurface.rateLimit.max,
      timeWindow: env.publicSurface.rateLimit.windowMs,
    },
  };

  const act = async (
    fastifyReq: { params: unknown; query: unknown },
    res: Parameters<typeof sendLinkText>[0],
  ) => {
    const { orgSlug } = fastifyReq.params as { orgSlug: string };
    const { subscriber, signature } = (fastifyReq.query ?? {}) as {
      subscriber?: unknown;
      signature?: unknown;
    };
    try {
      const { orgName } =
        await fastify.commandBus.execute<UnsubscribeCommandResult>(
          unsubscribeCommand({ orgSlug, subscriber, signature }),
        );
      return sendLinkText(res, 200, unsubscribedText(orgName));
    } catch (error) {
      if (
        error instanceof ArgumentInvalidException ||
        error instanceof NotFoundException
      ) {
        return sendLinkText(res, 404, INVALID_LINK_TEXT);
      }
      throw error;
    }
  };

  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/status/:orgSlug/subscribers/unsubscribe',
    schema: {
      description: 'Unsubscribe through the emailed link',
      tags: ['public'],
    },
    config,
    onSend: linkOnSend,
    handler: async (req, res) => {
      if (req.method === 'HEAD') return sendLinkText(res, 200, '');
      return act(req, res);
    },
  });

  fastify.route({
    method: 'POST',
    url: '/status/:orgSlug/subscribers/unsubscribe',
    schema: {
      description: 'Unsubscribe by RFC 8058 one-click POST',
      tags: ['public'],
    },
    config,
    onSend: linkOnSend,
    handler: async (req, res) => act(req, res),
  });
}
