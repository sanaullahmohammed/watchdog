/**
 * The longest an admin subscription's access re-check may wait for its
 * lookup (story 4.8). Kept apart from the resolver, which loads the
 * configuration and Better Auth, so a unit spec can test it without a `.env`.
 */
export const RECHECK_LOOKUP_MAX_MS = 10_000;

/** The interval, capped at `RECHECK_LOOKUP_MAX_MS`. */
export function recheckLookupDeadlineMs(intervalMs: number): number {
  return Math.min(intervalMs, RECHECK_LOOKUP_MAX_MS);
}
