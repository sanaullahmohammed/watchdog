import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auth } from '@/server/auth/auth';

/**
 * Mounts Better Auth's request handler under /api/auth.
 *
 * Better Auth speaks the Web Fetch API, so each Fastify request is translated
 * into a `Request` and its `Response` translated back. It owns validation for
 * everything under this prefix, so no TypeBox schema is attached; one would
 * reject shapes Better Auth accepts.
 *
 * See ARCHITECTURE.md section 7: auth is cross-cutting infrastructure mounted
 * outside the CQRS bus, not a domain module.
 */
export const AUTH_ROUTE_PREFIX = '/api/auth';

function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(
    request.url,
    `${request.protocol}://${request.headers.host ?? 'localhost'}`,
  );

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else if (value !== undefined) {
      headers.append(key, String(value));
    }
  }

  const methodHasBody = request.method !== 'GET' && request.method !== 'HEAD';

  return new Request(url, {
    method: request.method,
    headers,
    body:
      methodHasBody && request.body !== undefined
        ? JSON.stringify(request.body)
        : undefined,
  });
}

async function sendWebResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);

  // Headers.forEach folds repeated headers into one comma-joined value, which
  // corrupts Set-Cookie. Better Auth issues session cookies here, so they are
  // taken through getSetCookie and passed as an array.
  const setCookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') {
      reply.header(key, value);
    }
  });
  if (setCookies.length > 0) {
    reply.header('set-cookie', setCookies);
  }

  return reply.send(response.body === null ? null : await response.text());
}

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorate('auth', auth);

  fastify.route({
    method: ['GET', 'POST'],
    url: `${AUTH_ROUTE_PREFIX}/*`,
    handler: async (request, reply) =>
      sendWebResponse(reply, await auth.handler(toWebRequest(request))),
  });
}

export default fp(authPlugin, {
  name: 'auth',
});
