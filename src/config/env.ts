import envSchema from 'env-schema';
import { type Static, Type } from 'typebox';

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
  // Single connection string so the owner/app role split is expressible:
  // `api`/`worker` connect as watchdog_app (RLS enforced), DBMate migrates
  // as watchdog_owner via DBMATE_DATABASE_URL. See ARCHITECTURE.md 6.1.
  DATABASE_URL: Type.String(),
  // Better Auth reads these through this schema rather than `process.env`:
  // env-schema validates `.env` and returns an object, it never populates
  // `process.env`, so anything reading the latter is blind to `.env`.
  BETTER_AUTH_SECRET: Type.String({ minLength: 32 }),
  BETTER_AUTH_URL: Type.String({ default: 'http://localhost:3000' }),
  LOG_LEVEL: Type.Enum(LogLevel),
  NODE_ENV: Type.Enum(NodeEnv),
  HOST: Type.String({ default: 'localhost' }),
  PORT: Type.Number({ default: 3000 }),
  WORKER_HEARTBEAT_PATH: Type.String({
    default: '/tmp/watchdog-worker-heartbeat',
  }),
  WORKER_HEARTBEAT_MAX_AGE_MS: Type.Number({ default: 60_000 }),
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
  worker: {
    heartbeatPath: env.WORKER_HEARTBEAT_PATH,
    heartbeatMaxAgeMs: env.WORKER_HEARTBEAT_MAX_AGE_MS,
  },
};
