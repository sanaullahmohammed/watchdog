import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { env } from '@/config';
import { publicPageETag } from '@/modules/status-page/dtos/public-status-page.etag';
import { toPublicStatusPage } from '@/modules/status-page/dtos/public-status-page.present';
import { publicStatusPageResponseDtoSchema } from '@/modules/status-page/dtos/public-status-page.response.dto';
import { publicHeaders } from '@/shared/api/public-surface';
import { PUBLIC_PAGE_NOT_FOUND } from '@/shared/domain/public-page-miss';
import { NotFoundException } from '@/shared/exceptions';
import {
  type GetPublicStatusPageQueryResult,
  getPublicStatusPageQuery,
} from './get-public-status-page.handler';
import { getPublicStatusPageRequestParamsSchema } from './get-public-status-page.schema';

/**
 * `.public.route.ts`, not `.route.ts`: the loader registers these without the
 * `/api` prefix every other route carries, because FR17 names the path
 * `/status/:orgSlug`. The suffix still ends in `.route.ts`, so the parity and
 * authenticated-surface specs discover this file like any other, and a public
 * surface has to be allowlisted deliberately rather than slip past them.
 *
 * No `resolveOrganizationContext` here, by design: there is no session to
 * resolve. The organization comes from the slug, and every read behind it is
 * still tenant-scoped.
 */
export default async function getPublicStatusPage(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: ['GET', 'HEAD'],
    url: '/status/:orgSlug',
    schema: {
      description: "Read an organization's public status page",
      params: getPublicStatusPageRequestParamsSchema,
      response: {
        200: publicStatusPageResponseDtoSchema,
        // A validator matched: no body, by definition of 304.
        304: Type.Null(),
      },
      tags: ['public'],
    },
    // Anonymous and database-backed, so it is rationed by client IP. The
    // limiter is registered with `global: false`; this is the opt-in.
    config: {
      rateLimit: {
        max: env.publicSurface.rateLimit.max,
        timeWindow: env.publicSurface.rateLimit.windowMs,
      },
    },
    // A 304 carries no payload, so nothing may describe one either: serializing
    // the null below would otherwise announce a four-byte body that never
    // arrives, and a client can wait for bytes that do not come.
    // The public headers are set here, not in the handler, so the 404 (thrown
    // by the slug lookup) and the 429 (answered by the limiter before the
    // handler runs) carry them too. A browser cannot read an answer without them.
    // The route declares HEAD itself so Fastify adds no automatic HEAD route:
    // that one appends its own `onSend`, which calls `Buffer.byteLength(null)` on
    // the 304's null payload and answers 500. Here, a HEAD announces the length
    // the GET would have had and sends no body, for string and Buffer payloads
    // only: the only ones this route sends (the serialized page and the error
    // handler's JSON).
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
      const view =
        await fastify.queryBus.execute<GetPublicStatusPageQueryResult>(
          getPublicStatusPageQuery({ slug: req.params.orgSlug }),
        );

      const page = toPublicStatusPage(view);
      const etag = publicPageETag(page);

      res.header(
        'cache-control',
        `public, max-age=${env.publicSurface.maxAgeSeconds}`,
      );
      res.header('etag', etag);

      // A poller that already has this state gets told so, and pays for no
      // body. The tag ignores `generatedAt`, which changes every time.
      if (req.headers['if-none-match'] === etag) {
        return res.code(304).send(null);
      }

      return res.status(200).send(page);
    },
  });

  // A cross-origin conditional fetch is preflighted, because `If-None-Match`
  // is not a CORS-safelisted request header. Without this the page is readable
  // from another origin but never revalidatable, and every poll costs a body.
  // Deliberately not rationed: it touches no database.
  fastify.route({
    method: 'OPTIONS',
    url: '/status/:orgSlug',
    schema: { hide: true },
    handler: async (_req, res) => {
      publicHeaders(res);
      res.header('access-control-allow-methods', 'GET, OPTIONS');
      res.header('access-control-allow-headers', 'if-none-match');
      res.header('access-control-max-age', '86400');
      return res.code(204).send();
    },
  });

  // Whatever under /status the router cannot match (`/status/x/`, `/status/a/b`,
  // `/status`) gets the page's uniform miss and the public headers, instead of
  // the router's 404, which echoes the path and carries no CORS. An ordinary
  // route, not a not-found handler: Fastify wires the last-set not-found
  // handler into its 404 router's bad-URL path for the whole app. Literal
  // `method` and `url` because authenticated-surface.spec.ts reads only that.
  const rationed = {
    rateLimit: {
      max: env.publicSurface.rateLimit.max,
      timeWindow: env.publicSurface.rateLimit.windowMs,
    },
  };
  const uniformMiss = async () => {
    throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
  };
  const withPublicHeaders = async (
    _req: unknown,
    res: Parameters<typeof publicHeaders>[0],
    payload: unknown,
  ) => {
    publicHeaders(res);
    return payload;
  };
  fastify.route({
    method: ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    url: '/status',
    schema: { hide: true },
    config: rationed,
    onSend: withPublicHeaders,
    handler: uniformMiss,
  });
  fastify.route({
    method: ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    url: '/status/*',
    schema: { hide: true },
    config: rationed,
    onSend: withPublicHeaders,
    handler: uniformMiss,
  });
}
