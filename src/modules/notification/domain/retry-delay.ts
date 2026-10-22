/**
 * The wait after attempt `attempt` (1-based) failed, in seconds:
 * `min(base × 2^(attempt − 1), maxDelay)`. ARCHITECTURE 5.6, story 6.7.
 */
export function retryDelaySeconds(
  attempt: number,
  baseSeconds: number,
  maxDelaySeconds: number,
): number {
  return Math.min(baseSeconds * 2 ** (attempt - 1), maxDelaySeconds);
}
