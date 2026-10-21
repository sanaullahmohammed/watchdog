import { Type } from 'typebox';

/**
 * How often an admin subscription's socket re-checks its access, in seconds
 * (story 4.8, ARCHITECTURE 5.5). A subscriber who signs out, whose session
 * expires or who is removed from the organization is disconnected within one
 * interval plus the next re-check's lookup, which is cut off at
 * min(interval, 10 s). It becomes a timer delay, so it stops at the largest
 * delay Node's setTimeout honours; above it the timer fires at once. Declared
 * apart from `env.ts`, which composes it, so a unit spec can read the default
 * without a `.env`.
 */
export const realtimeEnvProperties = {
  ADMIN_SUBSCRIPTION_RECHECK_SECONDS: Type.Integer({
    default: 60,
    minimum: 1,
    maximum: 2_147_483,
  }),
};
