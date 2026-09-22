import type { FastifyBaseLogger } from 'fastify';

/**
 * How loudly a failed request is logged, decided by who caused it. REST's
 * error handler and GraphQL's error formatter both log through this.
 *
 * A server fault, 5xx, is logged at `error` with its stack: something broke
 * and someone should look. A caller's mistake, 4xx, is logged at `info`, or
 * `warn` for a refused credential (401, 403), with no stack: nothing in the
 * server broke, and on a public route anyone can cause one at will. Every miss
 * was once logged at `error` with a stack, so an anonymous caller could write
 * level-50 lines on demand (Epic 3 retrospective, AV-9, R-7).
 *
 * Not a Fastify plugin, so it lives outside `src/server/plugins`, which
 * autoload evaluates at boot.
 */
export function logFailure(
  log: FastifyBaseLogger,
  error: Error,
  statusCode: number,
  correlationId: string,
): void {
  if (statusCode >= 500) {
    log.error({ err: error, correlationId }, error.message);
    return;
  }

  const level = statusCode === 401 || statusCode === 403 ? 'warn' : 'info';
  log[level]({ statusCode, correlationId }, error.message);
}
