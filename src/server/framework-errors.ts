import type { FastifyReply, FastifyRequest } from 'fastify';
import { logFailure } from '@/server/error-logging';
import type { ApiErrorResponse } from '@/shared/api/api-error.response';
import { publicHeaders } from '@/shared/api/public-surface';

/**
 * Whether the router sees this target as under `/status`. Judged on the path
 * as the router sees it: an absolute-form origin removed, anything from `?`
 * dropped, and duplicate slashes collapsed (`ignoreDuplicateSlashes`). Letter
 * case is not folded: `/STATUS/x` is not the public page's path.
 */
export function isUnderStatus(url: string): boolean {
  const withoutOrigin = url.replace(/^https?:\/\/[^/?#]*/i, '');
  const path = (withoutOrigin.split('?', 1)[0] ?? '').replace(/\/{2,}/g, '/');
  return path === '/status' || path.startsWith('/status/');
}

/**
 * Fastify's `frameworkErrors` hook: it answers a malformed URL
 * (`FST_ERR_BAD_URL`) and a failed async constraint before any route, hook or
 * error handler exists for the request.
 *
 * Under `/status` a malformed URL gets a plain 400 in the error handler's
 * shape, without the path in the body, and the public headers, so a
 * cross-origin script can read it. Everything else gets Fastify's own default
 * answer, byte for byte.
 *
 * Setting this option makes Fastify log `incoming request` for every bad URL.
 * The default branch below writes `reply.raw` as Fastify's own does, so it
 * logs no completion line.
 */
export function frameworkErrors(
  error: Error & { code?: string },
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error.code === 'FST_ERR_BAD_URL' && isUnderStatus(request.url)) {
    logFailure(request.log, error, 400, request.id);
    publicHeaders(reply);
    // A HEAD answer has no body.
    if (request.method === 'HEAD') return reply.code(400).send();
    return reply.code(400).send({
      statusCode: 400,
      message: 'Bad Request',
      error: 'Bad Request',
      correlationId: request.id,
    } satisfies ApiErrorResponse);
  }

  const [status, body] =
    error.code === 'FST_ERR_BAD_URL'
      ? [
          400,
          JSON.stringify({
            error: 'Bad Request',
            code: 'FST_ERR_BAD_URL',
            message: error.message,
            statusCode: 400,
          }),
        ]
      : [
          500,
          '{"error":"Internal Server Error","message":"Unexpected error from async constraint","statusCode":500}',
        ];
  reply.raw.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  reply.raw.end(body);
}
