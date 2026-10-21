import addressparser from 'nodemailer/lib/addressparser';
import { Type } from 'typebox';

/**
 * Outgoing email (story 6.2, FR19, ARCHITECTURE 5.6). Every variable has a
 * default or is optional, so no environment has to declare one: the defaults
 * reach Mailpit on `localhost:1025`, which is where `docker compose up -d`
 * publishes it. Declared apart from `env.ts`, which composes it, so a unit
 * spec can read the defaults without a `.env`.
 *
 * `SMTP_USER`, `SMTP_PASSWORD` and `PUBLIC_BASE_URL` treat an empty string as
 * unset, because `.env.example` lists them as `NAME=` lines. The cross-field
 * rules env-schema cannot express live in `resolveEmailSettings`.
 */
export const notificationEnvProperties = {
  SMTP_HOST: Type.String({ default: 'localhost', minLength: 1 }),
  SMTP_PORT: Type.Integer({ default: 1025, minimum: 1, maximum: 65_535 }),
  SMTP_FROM: Type.String({
    default: 'WatchDog <watchdog@localhost>',
    minLength: 1,
  }),
  // Implicit TLS from the first byte (usually port 465). With `false` the
  // connection upgrades through STARTTLS when the server offers it.
  SMTP_SECURE: Type.Boolean({ default: false }),
  SMTP_USER: Type.Optional(Type.String()),
  SMTP_PASSWORD: Type.Optional(Type.String()),
  // The origin emailed links are built on. Unset, it is BETTER_AUTH_URL's.
  PUBLIC_BASE_URL: Type.Optional(Type.String()),
  // The anonymous subscribe route's own IP limit (story 6.3), and the
  // per-address bounds. The TTL is in hours, the resend window in seconds; 0
  // turns the throttle off.
  SUBSCRIBE_RATE_LIMIT_MAX: Type.Integer({ default: 5, minimum: 1 }),
  SUBSCRIBE_RATE_LIMIT_WINDOW_MS: Type.Integer({
    default: 3_600_000,
    minimum: 1_000,
  }),
  SUBSCRIBER_CONFIRMATION_TTL_HOURS: Type.Integer({
    default: 24,
    minimum: 1,
    maximum: 8760,
  }),
  SUBSCRIBER_CONFIRMATION_RESEND_SECONDS: Type.Integer({
    default: 600,
    minimum: 0,
    maximum: 86_400,
  }),
};

/**
 * The subscribe route takes one limiter, so ARCHITECTURE 5.4.1's "inherits the
 * public bounds" is kept here: it may be stricter than the public page's limit,
 * never looser. Names both variables of the pair that breaks the rule and never
 * quotes anything else. Pure, so a unit spec can call it without a `.env`.
 */
export function assertSubscribeLimits(values: {
  SUBSCRIBE_RATE_LIMIT_MAX: number;
  SUBSCRIBE_RATE_LIMIT_WINDOW_MS: number;
  PUBLIC_RATE_LIMIT_MAX: number;
  PUBLIC_RATE_LIMIT_WINDOW_MS: number;
}): void {
  if (values.SUBSCRIBE_RATE_LIMIT_MAX > values.PUBLIC_RATE_LIMIT_MAX) {
    throw new Error(
      `SUBSCRIBE_RATE_LIMIT_MAX (${values.SUBSCRIBE_RATE_LIMIT_MAX}) must not exceed PUBLIC_RATE_LIMIT_MAX (${values.PUBLIC_RATE_LIMIT_MAX})`,
    );
  }
  if (
    values.SUBSCRIBE_RATE_LIMIT_WINDOW_MS < values.PUBLIC_RATE_LIMIT_WINDOW_MS
  ) {
    throw new Error(
      `SUBSCRIBE_RATE_LIMIT_WINDOW_MS (${values.SUBSCRIBE_RATE_LIMIT_WINDOW_MS}) must not be shorter than PUBLIC_RATE_LIMIT_WINDOW_MS (${values.PUBLIC_RATE_LIMIT_WINDOW_MS})`,
    );
  }
}

export type EmailSettings = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
};

type RawEmailEnv = {
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_FROM: string;
  SMTP_SECURE: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  PUBLIC_BASE_URL?: string;
  BETTER_AUTH_URL: string;
};

const unsetIfEmpty = (value: string | undefined) =>
  value === undefined || value === '' ? undefined : value;

/**
 * The origin of `value`, or undefined when it is not an http(s) URL. Bare
 * means nothing beyond the origin: no credentials, path, query or fragment.
 * Decided on the parsed URL, so case, a default port and one trailing slash
 * are normalised away rather than refused.
 */
function httpOrigin(value: string, bare: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (
    bare &&
    (url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== '')
  ) {
    return undefined;
  }
  return url.origin;
}

/**
 * `value` as one mailbox, or undefined unless it parses to exactly one
 * address with a non-empty local part and domain. `WatchDog` alone would be
 * sent as `MAIL FROM:<>`, and `watchdog@` as given.
 */
export function parseFromAddress(
  value: string,
): { name: string; address: string } | undefined {
  const parsed = addressparser(value);
  if (parsed.length !== 1) return undefined;
  const [entry] = parsed;
  if (entry.group !== undefined || typeof entry.address !== 'string') {
    return undefined;
  }
  const at = entry.address.lastIndexOf('@');
  if (at <= 0 || at === entry.address.length - 1) return undefined;
  return { name: entry.name, address: entry.address };
}

/**
 * Applies the rules env-schema cannot: a login is both `SMTP_USER` and
 * `SMTP_PASSWORD` or neither, `SMTP_FROM` is exactly one address, and
 * `PUBLIC_BASE_URL` is a bare http(s) origin, defaulting to
 * `BETTER_AUTH_URL`'s. Each refusal names its variables and never quotes a
 * value, which could be a credential. Pure, so a unit spec can
 * call it without a `.env`.
 */
export function resolveEmailSettings(raw: RawEmailEnv): {
  email: EmailSettings;
  publicBaseUrl: string;
} {
  const user = unsetIfEmpty(raw.SMTP_USER);
  const pass = unsetIfEmpty(raw.SMTP_PASSWORD);
  if ((user === undefined) !== (pass === undefined)) {
    throw new Error(
      'SMTP_USER and SMTP_PASSWORD must be set together, or both left unset',
    );
  }
  if (parseFromAddress(raw.SMTP_FROM) === undefined) {
    throw new Error(
      'SMTP_FROM must be exactly one address with a local part and a domain, such as Status <status@example.com>',
    );
  }

  const configured = unsetIfEmpty(raw.PUBLIC_BASE_URL);
  let publicBaseUrl: string | undefined;
  if (configured !== undefined) {
    publicBaseUrl = httpOrigin(configured, true);
    if (publicBaseUrl === undefined) {
      throw new Error(
        'PUBLIC_BASE_URL must be a bare http(s) origin, such as https://example.com, with no credentials, path, query or fragment',
      );
    }
  } else {
    publicBaseUrl = httpOrigin(raw.BETTER_AUTH_URL, false);
    if (publicBaseUrl === undefined) {
      throw new Error(
        'PUBLIC_BASE_URL is unset and BETTER_AUTH_URL is not an http(s) URL to take its origin from',
      );
    }
  }

  return {
    email: {
      host: raw.SMTP_HOST,
      port: raw.SMTP_PORT,
      secure: raw.SMTP_SECURE,
      ...(user !== undefined && pass !== undefined
        ? { auth: { user, pass } }
        : {}),
      from: raw.SMTP_FROM,
    },
    publicBaseUrl,
  };
}
