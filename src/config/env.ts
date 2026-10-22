import envSchema from 'env-schema';
import { type Static, Type } from 'typebox';
import { parseAllowedCidrs } from './allowed-cidrs';
import { authEnvProperties } from './auth-env';
import { checkResultsEnvProperties } from './check-results-env';
import {
  assertRetryDelays,
  assertSubscribeLimits,
  notificationEnvProperties,
  resolveEmailSettings,
} from './notification-env';
import { realtimeEnvProperties } from './realtime-env';
import { assertWorkerIntervals } from './worker-intervals';

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
  ...checkResultsEnvProperties,
  ...realtimeEnvProperties,
  ...notificationEnvProperties,
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
  // The public stream's bounds (story 4.5, ARCHITECTURE 5.4.1). A stream is
  // long-lived, so it is capped per client IP and per api process, and closed
  // after its lifetime, after which the client reconnects. The heartbeat is
  // not one of 5.4.1's bounds: it keeps intermediaries from cutting a stream
  // that has been idle. The two times are in seconds and become timer delays,
  // so they stop at the largest delay Node's setTimeout honours; above it the
  // timer fires at once.
  PUBLIC_STREAM_MAX_PER_IP: Type.Number({ default: 10, minimum: 1 }),
  PUBLIC_STREAM_MAX_TOTAL: Type.Number({ default: 1000, minimum: 1 }),
  PUBLIC_STREAM_MAX_LIFETIME_SECONDS: Type.Number({
    default: 3600,
    minimum: 1,
    maximum: 2_147_483,
  }),
  PUBLIC_STREAM_HEARTBEAT_SECONDS: Type.Number({
    default: 30,
    minimum: 1,
    maximum: 2_147_483,
  }),
  WORKER_MAINTENANCE_INTERVAL_MS: Type.Number({
    default: 30_000,
    // A zero or negative interval would spin setInterval as a tight loop.
    // Fail at boot naming the variable rather than clamp it silently.
    minimum: 1_000,
    // Above Node's largest setInterval delay the timer fires every 1 ms.
    maximum: 2_147_483_647,
  }),
  // How often the monitor loop looks for due checks. The maximum is the
  // largest delay Node's setInterval honours; above it the timer fires every
  // 1 ms.
  WORKER_MONITOR_INTERVAL_MS: Type.Number({
    default: 10_000,
    minimum: 1_000,
    maximum: 2_147_483_647,
  }),
  // How long a worker loop may go without completing a pass before the
  // healthcheck fails. Four maintenance intervals by default. For the monitor
  // loop it is also the stall window: a tick fails when checks are queued or
  // running and none has settled for this long, so health turns red within
  // about twice this. A backlog alone is not a stall. It must exceed the
  // longest check timeout (60 s) plus recording; this is documented, not
  // enforced, beyond overdue > interval.
  WORKER_PASS_OVERDUE_MS: Type.Number({ default: 120_000, minimum: 1_000 }),
  // Comma-separated CIDR ranges a monitor target may resolve into although they
  // are loopback, private or otherwise blocked. Empty by default. ARCHITECTURE
  // 6.5.
  MONITOR_ALLOWED_CIDRS: Type.String({ default: '' }),
  // How many monitor checks one process runs at once. ARCHITECTURE 6.0.1.
  MONITOR_CHECK_CONCURRENCY: Type.Integer({
    default: 10,
    minimum: 1,
    maximum: 1000,
  }),
});

const env = envSchema<Static<typeof schema>>({
  dotenv: true,
  schema,
});

assertWorkerIntervals(env);
assertSubscribeLimits(env);
assertRetryDelays(env);

// An invalid entry fails boot, naming it.
const monitorAllowedCidrs = parseAllowedCidrs(env.MONITOR_ALLOWED_CIDRS);

// A half-set login or a PUBLIC_BASE_URL that is not a bare origin fails boot,
// naming the variables.
const { email, publicBaseUrl } = resolveEmailSettings(env);

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
    stream: {
      maxPerIp: env.PUBLIC_STREAM_MAX_PER_IP,
      maxTotal: env.PUBLIC_STREAM_MAX_TOTAL,
      maxLifetimeSeconds: env.PUBLIC_STREAM_MAX_LIFETIME_SECONDS,
      heartbeatSeconds: env.PUBLIC_STREAM_HEARTBEAT_SECONDS,
    },
  },
  // Outgoing email (story 6.2). `auth` is present only when both SMTP_USER
  // and SMTP_PASSWORD are set.
  email,
  // The origin emailed links are built on: PUBLIC_BASE_URL, or
  // BETTER_AUTH_URL's origin when that is unset.
  publicBaseUrl,
  notificationLinkSecret: env.NOTIFICATION_LINK_SECRET,
  notification: {
    cursorOverlapSeconds: env.NOTIFICATION_CURSOR_OVERLAP_SECONDS,
    retryBaseSeconds: env.NOTIFICATION_RETRY_BASE_SECONDS,
    retryMaxDelaySeconds: env.NOTIFICATION_RETRY_MAX_DELAY_SECONDS,
    maxAttempts: env.NOTIFICATION_MAX_ATTEMPTS,
    retentionDays: env.NOTIFICATION_RETENTION_DAYS,
  },
  subscribe: {
    rateLimit: {
      max: env.SUBSCRIBE_RATE_LIMIT_MAX,
      windowMs: env.SUBSCRIBE_RATE_LIMIT_WINDOW_MS,
    },
    confirmationTtlHours: env.SUBSCRIBER_CONFIRMATION_TTL_HOURS,
    confirmationResendSeconds: env.SUBSCRIBER_CONFIRMATION_RESEND_SECONDS,
    pendingGraceDays: env.SUBSCRIBER_PENDING_GRACE_DAYS,
  },
  realtime: {
    adminSubscriptionRecheckSeconds: env.ADMIN_SUBSCRIPTION_RECHECK_SECONDS,
  },
  monitor: {
    allowedCidrs: monitorAllowedCidrs,
    checkConcurrency: env.MONITOR_CHECK_CONCURRENCY,
    checkResultsRetentionDays: env.CHECK_RESULTS_RETENTION_DAYS,
    rollupRetentionDays: env.ROLLUP_RETENTION_DAYS,
  },
  worker: {
    heartbeatPath: env.WORKER_HEARTBEAT_PATH,
    heartbeatMaxAgeMs: env.WORKER_HEARTBEAT_MAX_AGE_MS,
    maintenanceIntervalMs: env.WORKER_MAINTENANCE_INTERVAL_MS,
    monitorIntervalMs: env.WORKER_MONITOR_INTERVAL_MS,
    notificationIntervalMs: env.NOTIFICATION_PASS_INTERVAL_MS,
    passOverdueMs: env.WORKER_PASS_OVERDUE_MS,
  },
};
