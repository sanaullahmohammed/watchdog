import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import path from 'node:path';
import AutoLoad from '@fastify/autoload';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import RateLimit from '@fastify/rate-limit';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import UnderPressure from '@fastify/under-pressure';
import type { BetterAuthOptions } from 'better-auth';
import type { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';
import env from '@/config/env';
import { isRationedGraphqlRequest } from '@/server/anonymous-graphql';
import { auth } from '@/server/auth/auth';
import { resolveActor } from '@/server/auth/organization-context';
import { isTrustedOrigin } from '@/server/auth/trusted-origin';
import { di } from '@/server/di';
import { graphqlErrorFormatter } from '@/server/graphql-error-formatter';
import { onePublicPagePerOperation } from '@/server/graphql-public-page-limit';
import getGQL from '@/server/plugins/gql';
import organizationEventsResolver from '@/server/realtime/organization-events.resolver';
import { TooManyRequestsException } from '@/shared/exceptions';

/**
 * What the admin subscription needs of a WebSocket. `ws` is not a direct
 * dependency, so its types are not ours to import; this is the part used.
 */
export type SubscriptionSocket = {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  once(event: 'close', listener: () => void): unknown;
};

/** What `@fastify/websocket` calls with each upgraded socket. */
type WsHandler = (
  this: unknown,
  socket: SubscriptionSocket,
  request: unknown,
) => unknown;

declare module 'mercurius' {
  interface MercuriusContext {
    /**
     * The upgrade request's headers, copied when the socket was upgraded.
     * Set only on a subscription; who is subscribing is read from these.
     */
    upgradeHeaders?: Readonly<IncomingHttpHeaders>;
    /** The subscription's socket, so a refusal can close it. */
    socket?: SubscriptionSocket;
    /**
     * Stops the socket's subscription deadline. Called when the socket's
     * first subscription is accepted.
     */
    clearSubscriptionDeadline?: () => void;
    /** The subscription's id on its socket, set by mercurius. */
    id?: string | number;
  }
}

/**
 * How long an upgraded socket may go without an accepted subscription. The
 * upgrade costs an anonymous caller one rationed request, and only a
 * subscription is authenticated; without this, that request would buy a
 * socket held open for as long as the caller liked, initialised or not.
 */
export const SUBSCRIPTION_DEADLINE_MS = 10_000;

/**
 * graphql-transport-ws's close code for a socket that did not initialise in
 * time, used here for one that did not subscribe in time.
 */
const SUBSCRIPTION_DEADLINE_CLOSE_CODE = 4408;

/**
 * How long `app.close()` lets a socket finish its closing handshake before it
 * is cut off, so a client that never answers the close frame cannot hold
 * shutdown open.
 */
const CLOSE_GRACE_MS = 500;

/** The close code for a server going away. */
const GOING_AWAY_CLOSE_CODE = 1001;

/** ws's `readyState` for a socket that has finished closing. */
const WS_CLOSED = 3;

/**
 * The origins a WebSocket upgrade may come from: `BETTER_AUTH_URL`'s, and any
 * `trustedOrigins` Better Auth is given. Exact origins only: a function or a
 * wildcard entry, which Better Auth also accepts, would need configuring here.
 */
function trustedUpgradeOrigins(): string[] {
  const configured = (auth.options as BetterAuthOptions).trustedOrigins;
  return [env.auth.baseUrl, ...(Array.isArray(configured) ? configured : [])];
}

export default async function createServer(fastify: FastifyInstance) {
  const trustedOrigins = trustedUpgradeOrigins();
  /**
   * Each upgrade's headers as they arrived. mercurius later merges the
   * `connection_init` payload's headers into the request's own, so this copy,
   * taken before any message can arrive, is the only one that cannot carry a
   * cookie the upgrade did not.
   */
  const upgradeHeaders = new WeakMap<
    IncomingMessage,
    Readonly<IncomingHttpHeaders>
  >();
  const deadlines = new WeakMap<SubscriptionSocket, NodeJS.Timeout>();
  /** Every upgraded socket still open, so closing the app can close them. */
  const sockets = new Set<SubscriptionSocket>();

  /** Stops a socket's subscription deadline, if it is still running. */
  const clearDeadline = (socket: SubscriptionSocket) => {
    clearTimeout(deadlines.get(socket));
    deadlines.delete(socket);
  };

  /** Starts a socket's subscription deadline, and tracks it until it closes. */
  const watchSocket = (socket: SubscriptionSocket) => {
    sockets.add(socket);
    const timer = setTimeout(
      () =>
        socket.close(
          SUBSCRIPTION_DEADLINE_CLOSE_CODE,
          'No subscription in time',
        ),
      SUBSCRIPTION_DEADLINE_MS,
    );
    timer.unref();
    deadlines.set(socket, timer);
    socket.once('close', () => {
      clearDeadline(socket);
      sockets.delete(socket);
    });
  };

  // mercurius registers `@fastify/websocket` and its `/graphql` route inside
  // plugins of its own, so neither the WebSocket server nor its hooks are
  // reachable from here. Its route still passes through this hook, which the
  // child contexts inherit and run before `@fastify/websocket`'s own, so the
  // handler it is handed already watches each socket it is given.
  fastify.addHook('onRoute', (routeOptions) => {
    const route = routeOptions as typeof routeOptions & {
      wsHandler?: WsHandler;
    };
    const wsHandler = route.wsHandler;
    if (route.url !== '/graphql' || typeof wsHandler !== 'function') return;
    route.wsHandler = function (this: unknown, socket, request) {
      watchSocket(socket);
      return wsHandler.call(this, socket, request);
    };
  });

  // Graphql
  await fastify.register(mercurius, {
    schema: await getGQL(),
    graphiql: env.isDevelopment,
    defineMutation: true,
    errorFormatter: graphqlErrorFormatter,
    // One page per operation: aliasing the field is how a single request asks
    // for a hundred page compositions (Epic 3 retrospective, R-5).
    validationRules: [onePublicPagePerOperation],
    // Subscriptions over WebSocket, for the admin dashboard (story 4.7,
    // ARCHITECTURE 5.5). `fullWsTransport` stays unset, so a query or a
    // mutation sent over the socket is refused: HTTP stays their only
    // transport. The upgrade is `GET /graphql`, so the anonymous limit's
    // `onRequest` hook below rations it before any of this runs.
    subscription: {
      // Two arguments, or ws answers every refusal with a 401. A browser
      // attaches the session cookie to a cross-site upgrade, so only a trusted
      // `Origin` is let through, with a cookie or without.
      verifyClient: (info, next) => {
        upgradeHeaders.set(info.req, Object.freeze({ ...info.req.headers }));
        const origin = info.req.headers.origin;
        if (!isTrustedOrigin(origin, trustedOrigins)) {
          // A refused credential: `warn`, no stack (`logFailure`'s policy).
          fastify.log.warn(
            { statusCode: 403, origin: origin ?? null },
            'Refused a WebSocket upgrade from an untrusted origin',
          );
          next(false, 403);
          return;
        }
        next(true);
      },
      // Run at every `connection_init`, so it only hands on what the upgrade
      // fixed: it reads no header of its own. The deadline is not stopped
      // here: only an accepted subscription stops it (the resolver).
      context: (socket, request) => {
        const own = socket as unknown as SubscriptionSocket;
        return {
          upgradeHeaders: upgradeHeaders.get(request.raw) ?? {},
          socket: own,
          clearSubscriptionDeadline: () => clearDeadline(own),
        };
      },
    },
  });

  // Anonymous traffic is bounded by client IP. `global: false`, so only the
  // surfaces below opt in: the public page through its route's config, and
  // /graphql through the hook after it, which decides who is anonymous in
  // `isRationedGraphqlRequest`.
  await fastify.register(RateLimit, {
    global: false,
    max: env.publicSurface.rateLimit.max,
    timeWindow: env.publicSurface.rateLimit.windowMs,
    // The plugin throws what this returns. Anything but an ExceptionBase would
    // be masked as a 500 by the error handler, so a rationed caller would be
    // told the server broke.
    errorResponseBuilder: (_request, context) =>
      new TooManyRequestsException(
        `Rate limit exceeded, retry in ${context.after}`,
      ),
  });

  const limitAnonymous = fastify.createRateLimit({
    max: env.publicSurface.rateLimit.max,
    timeWindow: env.publicSurface.rateLimit.windowMs,
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (!(await isRationedGraphqlRequest(request, resolveActor))) return;

    // `isAllowed` is true only for an allow-listed key; a request within the
    // limit comes back with `isExceeded: false`, which is the field to read.
    const status = await limitAnonymous(request);
    if (status.isAllowed || !status.isExceeded) return;

    reply.header('retry-after', status.ttlInSeconds);
    reply.header('x-ratelimit-limit', status.max);
    reply.header('x-ratelimit-remaining', 0);
    reply.header('x-ratelimit-reset', status.ttlInSeconds);
    throw new TooManyRequestsException(
      `Rate limit exceeded, retry in ${status.ttlInSeconds} seconds`,
    );
  });

  // Set sensible default security headers
  await fastify.register(Helmet, {
    global: true,
    // The following settings are needed for graphiql, see https://github.com/graphql/graphql-playground/issues/1283
    contentSecurityPolicy: !env.isDevelopment,
    crossOriginEmbedderPolicy: !env.isDevelopment,
  });

  // Enables the use of CORS in a Fastify application.
  // https://en.wikipedia.org/wiki/Cross-origin_resource_sharing
  await fastify.register(Cors, {
    origin: false,
  });

  // Auto-load plugins
  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, 'plugins'),
    dirNameRoutePrefix: false,
  });

  // Configure Dependency Injection
  await di(fastify);

  const surfaceFile = env.isProduction
    ? /\.(route|resolver)\.js$/
    : /\.(route|resolver)\.(ts|js)$/;
  // A public route serves a path that carries no `/api` prefix: FR17 names
  // `/status/:orgSlug`. The suffix still ends in `.route.ts`, so the parity
  // and authenticated-surface specs discover these files like any other, and
  // a public surface has to be allowlisted rather than slip past them.
  const publicRouteFile = env.isProduction
    ? /\.public\.route\.js$/
    : /\.public\.route\.(ts|js)$/;

  // Auto-load routes
  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, '../modules'),
    dirNameRoutePrefix: false,
    // `autoPrefix` is a property a plugin file exports, not an option the
    // loader accepts, so passing it here did nothing and every route was
    // served at /v1 despite FR26 requiring /api. Fastify honours `prefix` in
    // the options it hands each plugin, which does apply.
    options: {
      prefix: '/api',
    },
    matchFilter: (path) =>
      surfaceFile.test(path) && !publicRouteFile.test(path),
  });

  // Public routes, at the paths the product names rather than under /api.
  await fastify.register(AutoLoad, {
    dir: path.join(__dirname, '../modules'),
    dirNameRoutePrefix: false,
    matchFilter: (path) => publicRouteFile.test(path),
  });

  // The admin subscription, which lives beside the GraphQL wiring rather than
  // in a module, so the resolver autoloader above does not see it.
  await fastify.register(organizationEventsResolver);

  // Closing the app closes every socket. Registered after the realtime hub's
  // `preClose`, which has by now ended every subscription, so a subscriber is
  // sent its `complete` before the close frame. `@fastify/websocket`'s own
  // `preClose` belongs to mercurius's child context and runs after this one,
  // finding nothing left to close. A socket that has not finished its closing
  // handshake within the grace is cut off, so a client that never answers the
  // close frame cannot hold `app.close()` open.
  fastify.addHook('preClose', async () => {
    // One turn of the event loop, so every subscription the hub just ended
    // has written its `complete` before any close frame is queued.
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WS_CLOSED) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              socket.terminate();
              resolve();
            }, CLOSE_GRACE_MS);
            socket.once('close', () => {
              clearTimeout(timer);
              resolve();
            });
            socket.close(GOING_AWAY_CLOSE_CODE, 'Server shutting down');
          }),
      ),
    );
  });

  await fastify.register(UnderPressure);

  return fastify.withTypeProvider<TypeBoxTypeProvider>();
}
