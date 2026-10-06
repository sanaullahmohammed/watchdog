import type { FastifyRequest } from 'fastify';
import type { resolveActor } from '@/server/auth/organization-context';

type ResolveActor = typeof resolveActor;

/**
 * True when a request to the GraphQL route has no valid session and so counts
 * against the anonymous bucket. "Anonymous" is decided by resolving the
 * session, never by the presence of a `Cookie` header, and the route is matched
 * rather than the raw URL, so GET, HEAD and `//graphql` are covered too.
 * A failed lookup fails closed: the caller is treated as anonymous.
 *
 * The caller passes the session lookup in, rather than this module importing
 * it: importing it would load the Better Auth instance, which reads database
 * configuration at import, and the unit suite runs without any.
 */
export async function isRationedGraphqlRequest(
  request: Pick<FastifyRequest, 'routeOptions' | 'headers' | 'log'>,
  resolve: ResolveActor,
): Promise<boolean> {
  if (request.routeOptions?.url !== '/graphql') return false;
  if (!request.headers.cookie) return true;
  try {
    return (await resolve(request.headers)) == null;
  } catch (err) {
    request.log.warn(
      { err },
      'session lookup failed; treating the request as anonymous',
    );
    return true;
  }
}
