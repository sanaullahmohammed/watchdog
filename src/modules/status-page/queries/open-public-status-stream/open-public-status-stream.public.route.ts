import type { OutgoingHttpHeaders } from 'node:http';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { env } from '@/config';
import { publicPageETag } from '@/modules/status-page/dtos/public-status-page.etag';
import { toPublicStatusPage } from '@/modules/status-page/dtos/public-status-page.present';
import { getPublicStatusPageRequestParamsSchema } from '@/modules/status-page/queries/get-public-status-page/get-public-status-page.schema';
import { logFailure } from '@/server/error-logging';
import { publicHeaders } from '@/shared/api/public-surface';
import { getRequestId } from '@/shared/app/app-request-context';
import { TooManyRequestsException } from '@/shared/exceptions';
import {
  type OpenPublicStatusEventStreamQueryResult,
  openPublicStatusEventStreamQuery,
} from './open-public-status-stream.handler';
import {
  createStreamAdmission,
  type ReleaseStreamPlace,
} from './public-stream-admission';

/**
 * The public status stream, `GET /status/:orgSlug/events` (story 4.5,
 * ARCHITECTURE 5.4.1 and 5.5). Server-Sent Events, so REST only: it has no SDL
 * form, and GraphQL subscriptions are admin-only (ARCHITECTURE 7.1).
 *
 * It opens with the page `GET /status/:orgSlug` answers, as one unnamed event
 * whose `id` is that page's `ETag`, then holds the organization's public hub
 * subscription and writes a heartbeat comment whenever it has been quiet for
 * an interval. Pushing a new page when it changes is story 4.6.
 *
 * Bounded like the page and more: openings are rationed by IP; open streams
 * are capped per IP and per process; each ends after its lifetime; and closing
 * the app ends them all, through the hub's `closed`, which it sends in
 * `preClose` so the server's own close does not wait on them.
 *
 * `Last-Event-ID` is ignored. A reconnecting client is sent the current page,
 * which is everything it could have missed.
 *
 * No `resolveOrganizationContext`, by design: there is no session. The
 * organization comes from the slug, and the page behind it is read under it.
 */

const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';
const HEARTBEAT = ': heartbeat\n\n';

export default async function openPublicStatusStream(
  fastify: FastifyRouteInstance,
) {
  // One per app, so its places are this app's streams.
  const admission = createStreamAdmission({
    maxPerIp: env.publicSurface.stream.maxPerIp,
    maxTotal: env.publicSurface.stream.maxTotal,
  });
  const heartbeatMs = env.publicSurface.stream.heartbeatSeconds * 1000;
  const lifetimeMs = env.publicSurface.stream.maxLifetimeSeconds * 1000;

  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/status/:orgSlug/events',
    // An automatic HEAD would run this handler, hijack and hold a stream open
    // with no body. Without it, a HEAD gets the catch-all's uniform miss.
    exposeHeadRoute: false,
    schema: {
      description:
        "Open a stream of an organization's public status page, as Server-Sent Events",
      // The page's own: a plain string, so a malformed slug still reaches the
      // slug rule and gets the page's 404 rather than a 400.
      params: getPublicStatusPageRequestParamsSchema,
      tags: ['public'],
    },
    // Openings are rationed like the page, in a bucket of their own.
    config: {
      rateLimit: {
        max: env.publicSurface.rateLimit.max,
        timeWindow: env.publicSurface.rateLimit.windowMs,
      },
    },
    // Every answer before the hijack (the 404, the limiter's and the caps'
    // 429, a masked 500) is read by a script on another origin, so it carries
    // the public headers. The stream's own head is written past `onSend`.
    onSend: async (_req, res, payload) => {
      publicHeaders(res);
      return payload;
    },
    handler: async (req, reply) => {
      // 1. Compose. A miss throws the page's uniform 404 from here.
      const view =
        await fastify.queryBus.execute<OpenPublicStatusEventStreamQueryResult>(
          openPublicStatusEventStreamQuery({ slug: req.params.orgSlug }),
        );
      const page = toPublicStatusPage(view);
      const etag = publicPageETag(page);

      // From here to the subscription there is no `await`, so no other
      // opening can be counted between the cap check and the hijack.

      // 2. Gone while the page was composed: nothing to admit or subscribe.
      // With the socket destroyed, Fastify sends nothing for an undefined.
      if (reply.raw.destroyed) return;

      // 3. Take a place, or refuse. A refusal holds nothing.
      const release: ReleaseStreamPlace | undefined = admission.admit(req.ip);
      if (!release) {
        throw new TooManyRequestsException(
          'Too many open status streams, retry later',
        );
      }

      const raw = reply.raw;
      let done = false;
      let hijacked = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let lifetime: NodeJS.Timeout | undefined;

      // The one way a stream ends, whatever ends it: the client going, its
      // lifetime, a write error, the hub closing, or a throw below.
      const cleanup = ({ destroy = false }: { destroy?: boolean } = {}) => {
        if (done) return;
        done = true;
        release();
        unsubscribe?.();
        clearTimeout(heartbeat);
        clearTimeout(lifetime);
        // Before the hijack the error handler still owns the reply.
        if (!hijacked || raw.destroyed || raw.writableEnded) return;
        if (destroy) raw.destroy();
        else raw.end();
      };

      const armHeartbeat = () => {
        clearTimeout(heartbeat);
        if (done) return;
        heartbeat = setTimeout(() => send(HEARTBEAT), heartbeatMs);
        heartbeat.unref();
      };

      // Every write after the first event goes through here, so the heartbeat
      // is written only after an interval with nothing else.
      const send = (chunk: string) => {
        if (done) return;
        raw.write(chunk);
        armHeartbeat();
      };

      try {
        // 4. The stream's head. The public headers go last, so their
        // `cross-origin-resource-policy` wins over helmet's, which
        // `getHeaders()` merges in from the raw response.
        reply.header('content-type', SSE_CONTENT_TYPE);
        reply.header('cache-control', 'no-store');
        reply.header('x-accel-buffering', 'no');
        publicHeaders(reply);
        reply.hijack();
        hijacked = true;
        // Fastify types a few named headers narrower than Node's writeHead,
        // which takes any of them as a number or a string.
        raw.writeHead(200, reply.getHeaders() as OutgoingHttpHeaders);

        // 5. The current page, unnamed so `EventSource.onmessage` gets it,
        // with its ETag verbatim, quotes included, as the event's id.
        raw.write(`id: ${etag}\ndata: ${JSON.stringify(page)}\n\n`);

        // 6. Read at request time. On a hub already closed, `closed` arrives
        // before this returns, so cleanup has run and the stream is done.
        const off = fastify.realtimeHub.subscribePublic(
          view.organization.id,
          (signal) => {
            if (signal.kind === 'closed') cleanup();
          },
        );
        if (done) off();
        else unsubscribe = off;

        // 7. Keep it alive, bound its life, and notice when it ends.
        if (!done) {
          armHeartbeat();
          lifetime = setTimeout(() => cleanup(), lifetimeMs);
          lifetime.unref();
          raw.on('close', () => cleanup());
          raw.on('error', () => cleanup({ destroy: true }));
        }
      } catch (error) {
        if (!hijacked) {
          // The error handler answers this one, with the public headers.
          cleanup();
          throw error;
        }
        // No error handler runs after the hijack, so it is logged here, as
        // the error handler would log a 500.
        logFailure(
          req.log,
          error instanceof Error ? error : new Error(String(error)),
          500,
          getRequestId(),
        );
        cleanup({ destroy: true });
      }
    },
  });

  // `EventSource` sends no custom headers, but a script reading the stream
  // with `fetch` may resume with `Last-Event-ID`, which is not CORS-safelisted.
  // Deliberately not rationed: it touches no database.
  fastify.route({
    method: 'OPTIONS',
    url: '/status/:orgSlug/events',
    schema: { hide: true },
    handler: async (_req, res) => {
      publicHeaders(res);
      res.header('access-control-allow-methods', 'GET, OPTIONS');
      res.header('access-control-allow-headers', 'last-event-id');
      res.header('access-control-max-age', '86400');
      return res.code(204).send();
    },
  });
}
