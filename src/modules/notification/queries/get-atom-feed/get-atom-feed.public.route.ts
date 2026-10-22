import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { env } from '@/config';
import {
  atomFeedETag,
  toAtomFeed,
} from '@/modules/notification/dtos/atom-feed';
import { publicHeaders } from '@/shared/api/public-surface';
import {
  type GetAtomFeedQueryResult,
  getAtomFeedQuery,
} from './get-atom-feed.handler';
import { getAtomFeedRequestParamsSchema } from './get-atom-feed.schema';

/**
 * `GET /status/:orgSlug/feed.atom` (story 6.8, FR20): the latest public
 * changes as an Atom feed, read by anyone. Public by design, with the page's
 * bounds (ARCHITECTURE 5.4.1): rate limit by IP, validators, CORS without
 * credentials. The miss is the page's uniform 404, thrown by the handler.
 */
export default async function getAtomFeed(fastify: FastifyRouteInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: ['GET', 'HEAD'],
    url: '/status/:orgSlug/feed.atom',
    schema: {
      description: "Follow an organization's public changes as an Atom feed",
      params: getAtomFeedRequestParamsSchema,
      tags: ['public'],
    },
    config: {
      rateLimit: {
        max: env.publicSurface.rateLimit.max,
        timeWindow: env.publicSurface.rateLimit.windowMs,
      },
    },
    // As the page's: the public headers on every answer (the 404 and 429
    // included), no length on a 304, and a HEAD announces the GET's length.
    onSend: async (req, res, payload) => {
      publicHeaders(res);
      if (res.statusCode === 304) {
        res.removeHeader('content-length');
        return null;
      }
      if (req.method === 'HEAD') {
        if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
          res.header('content-length', Buffer.byteLength(payload));
          return null;
        }
      }
      return payload;
    },
    handler: async (req, res) => {
      const view = await fastify.queryBus.execute<GetAtomFeedQueryResult>(
        getAtomFeedQuery({ slug: req.params.orgSlug }),
      );
      const body = toAtomFeed(view, env.publicBaseUrl);
      const etag = atomFeedETag(body);

      res.header(
        'cache-control',
        `public, max-age=${env.publicSurface.maxAgeSeconds}`,
      );
      res.header('etag', etag);

      if (req.headers['if-none-match'] === etag) {
        return res.code(304).send(null);
      }
      return res
        .status(200)
        .type('application/atom+xml; charset=utf-8')
        .send(body);
    },
  });

  // The preflight a cross-origin conditional fetch needs. Not rationed: it
  // touches no database.
  fastify.route({
    method: 'OPTIONS',
    url: '/status/:orgSlug/feed.atom',
    schema: { hide: true },
    handler: async (_req, res) => {
      publicHeaders(res);
      res.header('access-control-allow-methods', 'GET, OPTIONS');
      res.header('access-control-allow-headers', 'if-none-match');
      res.header('access-control-max-age', '86400');
      return res.code(204).send();
    },
  });
}
