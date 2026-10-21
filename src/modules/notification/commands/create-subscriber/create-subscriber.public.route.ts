import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { env } from '@/config';
import {
  SUBSCRIBE_ACCEPTED_MESSAGE,
  subscribeAcceptedDtoSchema,
} from '@/modules/notification/dtos/subscribe.response.dto';
import { publicHeaders } from '@/shared/api/public-surface';
import {
  type CreateSubscriberCommandResult,
  createSubscriberCommand,
} from './create-subscriber.handler';
import { createSubscriberRequestDtoSchema } from './create-subscriber.schema';

/**
 * `POST /status/:orgSlug/subscribers` (story 6.3, FR21). Anonymous, so it
 * carries 5.4.1's bounds: its own per-IP limit, the public headers on every
 * answer, and CORS without credentials. Every accepted request gets one
 * identical 202, whatever state the address is in.
 */
export default async function createSubscriber(fastify: FastifyRouteInstance) {
  // The confirmation emails the route started are finished before the app
  // closes. This touches no database.
  fastify.addHook('onClose', async () => {
    await fastify.diContainer.cradle.confirmationSendsService.drain();
  });

  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'POST',
    url: '/status/:orgSlug/subscribers',
    schema: {
      description: "Subscribe an address to an organization's status updates",
      body: createSubscriberRequestDtoSchema,
      response: { 202: subscribeAcceptedDtoSchema },
      tags: ['public'],
    },
    config: {
      rateLimit: {
        max: env.subscribe.rateLimit.max,
        timeWindow: env.subscribe.rateLimit.windowMs,
      },
    },
    // On every answer, including the 400, 404 and the limiter's 429.
    onSend: async (_req, res, payload) => {
      publicHeaders(res);
      return payload;
    },
    handler: async (req, res) => {
      const { orgSlug } = req.params as { orgSlug: string };
      await fastify.commandBus.execute<CreateSubscriberCommandResult>(
        createSubscriberCommand({ orgSlug, email: req.body.email }),
      );
      return res
        .code(202)
        .header('cache-control', 'no-store')
        .send({ message: SUBSCRIBE_ACCEPTED_MESSAGE });
    },
  });

  // Not rationed: it touches no database. Declared here because the catch-all
  // `/status/*` would answer a preflight with the uniform miss.
  fastify.route({
    method: 'OPTIONS',
    url: '/status/:orgSlug/subscribers',
    schema: { hide: true },
    handler: async (_req, res) => {
      publicHeaders(res);
      res.header('access-control-allow-methods', 'POST, OPTIONS');
      res.header('access-control-allow-headers', 'content-type');
      res.header('access-control-max-age', '86400');
      return res.code(204).send();
    },
  });
}
