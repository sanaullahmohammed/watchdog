import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { env } from '@/config';
import { publicPageETag } from '@/modules/status-page/dtos/public-status-page.etag';
import { toPublicStatusPage } from '@/modules/status-page/dtos/public-status-page.present';
import { publicStatusPageResponseDtoSchema } from '@/modules/status-page/dtos/public-status-page.response.dto';
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
    method: 'GET',
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
    onSend: async (_req, res, payload) => {
      if (res.statusCode !== 304) return payload;
      res.removeHeader('content-length');
      return null;
    },
    handler: async (req, res) => {
      const view =
        await fastify.queryBus.execute<GetPublicStatusPageQueryResult>(
          getPublicStatusPageQuery({ slug: req.params.orgSlug }),
        );

      const page = toPublicStatusPage(view);
      const etag = publicPageETag(page);

      publicHeaders(res);
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
}

/**
 * Headers that let a browser on any origin read the page.
 *
 * CORS is registered globally with `origin: false`, which is right for every
 * authenticated surface: a page anyone may fetch is not one any site may read
 * with a session attached. So this route says so for itself, without
 * credentials. Helmet's default `Cross-Origin-Resource-Policy: same-origin`
 * would block a cross-origin read even with CORS, so it is relaxed here only
 * (Epic 3 retrospective, R-15). `ETag` has to be exposed, or a script cannot
 * read the tag it needs for a conditional request.
 */
function publicHeaders(res: {
  header: (name: string, value: string) => unknown;
}) {
  res.header('access-control-allow-origin', '*');
  res.header('access-control-expose-headers', 'ETag');
  res.header('cross-origin-resource-policy', 'cross-origin');
}
