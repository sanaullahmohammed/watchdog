import type { FastifyBaseLogger } from 'fastify';
import { logMessageOf } from '@/shared/db/sql-debug';

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
 * The line's message is never a database error's own text, which can quote a
 * value such as a subscriber's address: a 5xx caused by one says `Database
 * error <code>`. Fastify's own refusal of a request (`FST_ERR_...`) logs its
 * code, because its message can quote the request: a malformed JSON body's
 * parse error quotes part of the body. The response is not affected.
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
    log.error({ err: error, correlationId }, logMessageOf(error));
    return;
  }

  const level = statusCode === 401 || statusCode === 403 ? 'warn' : 'info';
  const { code } = error as { code?: unknown };
  const message =
    typeof code === 'string' && code.startsWith('FST_ERR_')
      ? code
      : logMessageOf(error);
  log[level]({ statusCode, correlationId }, message);
}
