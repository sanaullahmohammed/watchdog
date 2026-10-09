import { Type } from 'typebox';

/**
 * The bounds DOMAIN's Monitor table records. The request schemas and the
 * migration's CHECK constraints both state them, so a value one accepts and the
 * other refuses cannot reach the database.
 */
export const MONITOR_TYPES = ['http', 'tcp', 'keyword', 'ssl_expiry'] as const;

export const MONITOR_LIMITS = {
  name: { min: 1, max: 120 },
  target: { min: 1, max: 2048 },
  intervalSeconds: { min: 30, max: 86_400, default: 60 },
  timeoutSeconds: { min: 1, max: 60, default: 10 },
  failureThreshold: { min: 1, max: 20, default: 3 },
  keyword: { min: 1, max: 256 },
  warnDays: { min: 1, max: 365 },
} as const;

export const MONITOR_DEFAULT_ENABLED = true;

/**
 * Type-specific configuration. Lives here, not in a slice's `.schema.ts`, which
 * must export exactly one object (the request) for the parity contract, and
 * both slices embed this one. The SDL declares the same two keys as a typed
 * input rather than a JSON scalar.
 */
export const monitorConfigSchema = Type.Object(
  {
    keyword: Type.Optional(
      Type.String({
        description: 'Text a keyword monitor must find in the response body',
        minLength: MONITOR_LIMITS.keyword.min,
        maxLength: MONITOR_LIMITS.keyword.max,
        // At least one non-space character.
        pattern: '\\S',
      }),
    ),
    warnDays: Type.Optional(
      Type.Integer({
        description: 'Days before expiry within which an SSL monitor warns',
        minimum: MONITOR_LIMITS.warnDays.min,
        maximum: MONITOR_LIMITS.warnDays.max,
      }),
    ),
  },
  { additionalProperties: false },
);
