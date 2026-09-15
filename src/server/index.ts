import path from 'node:path';
import AutoLoad from '@fastify/autoload';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import UnderPressure from '@fastify/under-pressure';
import type { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';
import env from '@/config/env';
import { di } from '@/server/di';
import getGQL from '@/server/plugins/gql';

export default async function createServer(fastify: FastifyInstance) {
  // Graphql
  await fastify.register(mercurius, {
    schema: await getGQL(),
    graphiql: env.isDevelopment,
    defineMutation: true,
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
