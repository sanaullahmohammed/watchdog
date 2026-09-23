import envSchema from 'env-schema';
import { type Static, Type } from 'typebox';
import { authEnvProperties } from './auth-env';

enum NodeEnv {
  development = 'development',
  production = 'production',
  test = 'test',
}

export enum LogLevel {
  debug = 'debug',
  info = 'info',
  warn = 'warn',
  error = 'error',
}

const schema = Type.Object({
  // DATABASE_URL, BETTER_AUTH_SECRET and BETTER_AUTH_URL are declared once, in
  // ./auth-env, and composed in here. That file is what `auth.ts` loads, so the
  // Better Auth CLI validates only the variables Better Auth needs while the
  // application still validates everything in one place.
  //
  // DATABASE_URL being a single connection string is what makes the owner/app
  // role split expressible: `api` and `worker` connect as watchdog_app under
  // RLS, DBMate migrates as watchdog_owner through DBMATE_DATABASE_URL.
  // See ARCHITECTURE.md 6.1.
  ...authEnvProperties,
  LOG_LEVEL: Type.Enum(LogLevel),
  NODE_ENV: Type.Enum(NodeEnv),
  HOST: Type.String({ default: 'localhost' }),
  PORT: Type.Number({ default: 3000 }),
  WORKER_HEARTBEAT_PATH: Type.String({
    default: '/tmp/watchdog-worker-heartbeat',
  }),
  WORKER_HEARTBEAT_MAX_AGE_MS: Type.Number({ default: 60_000 }),
  // The public surface's bounds (Epic 3 retrospective, R-5). Defaulted, so no
  // environment has to declare them, and tunable where one wants to.
  PUBLIC_PAGE_MAX_AGE_SECONDS: Type.Number({ default: 10, minimum: 0 }),
  PUBLIC_RATE_LIMIT_MAX: Type.Number({ default: 120, minimum: 1 }),
  PUBLIC_RATE_LIMIT_WINDOW_MS: Type.Number({ default: 60_000, minimum: 1_000 }),
  WORKER_MAINTENANCE_INTERVAL_MS: Type.Number({
    default: 30_000,
    // A zero or negative interval would spin setInterval as a tight loop.
    // Fail at boot naming the variable rather than clamp it silently.
    minimum: 1_000,
  }),
});

const env = envSchema<Static<typeof schema>>({
  dotenv: true,
  schema,
});

export default {
  nodeEnv: env.NODE_ENV,
  isDevelopment: env.NODE_ENV === NodeEnv.development,
  isProduction: env.NODE_ENV === NodeEnv.production,
  version: process.env.npm_package_version ?? '0.0.0',
  log: {
    level: env.LOG_LEVEL,
  },
  server: {
    host: env.HOST,
    port: env.PORT,
  },
  db: {
    url: env.DATABASE_URL,
  },
  auth: {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,
  },
  publicSurface: {
    maxAgeSeconds: env.PUBLIC_PAGE_MAX_AGE_SECONDS,
    rateLimit: {
      max: env.PUBLIC_RATE_LIMIT_MAX,
      windowMs: env.PUBLIC_RATE_LIMIT_WINDOW_MS,
    },
  },
  worker: {
    heartbeatPath: env.WORKER_HEARTBEAT_PATH,
    heartbeatMaxAgeMs: env.WORKER_HEARTBEAT_MAX_AGE_MS,
    maintenanceIntervalMs: env.WORKER_MAINTENANCE_INTERVAL_MS,
  },
};
