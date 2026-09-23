import path from 'node:path';
import AutoLoad from '@fastify/autoload';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import RateLimit from '@fastify/rate-limit';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import UnderPressure from '@fastify/under-pressure';
import type { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';
import env from '@/config/env';
import { di } from '@/server/di';
import { graphqlErrorFormatter } from '@/server/graphql-error-formatter';
import { onePublicPagePerOperation } from '@/server/graphql-public-page-limit';
import getGQL from '@/server/plugins/gql';
import { TooManyRequestsException } from '@/shared/exceptions';

export default async function createServer(fastify: FastifyInstance) {
  // Graphql
  await fastify.register(mercurius, {
    schema: await getGQL(),
    graphiql: env.isDevelopment,
    defineMutation: true,
    errorFormatter: graphqlErrorFormatter,
    // One page per operation: aliasing the field is how a single request asks
    // for a hundred page compositions (Epic 3 retrospective, R-5).
    validationRules: [onePublicPagePerOperation],
  });

  // Anonymous traffic is bounded by client IP. `global: false`, so only the
  // surfaces below opt in: the public page through its route's config, and
  // /graphql through the hook after it, for callers arriving with no session
  // cookie. An operator's own requests are not rationed.
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
    const anonymous =
      request.method === 'POST' &&
      request.url.startsWith('/graphql') &&
      !request.headers.cookie;
    if (!anonymous) return;

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

  await fastify.register(UnderPressure);

  return fastify.withTypeProvider<TypeBoxTypeProvider>();
}
