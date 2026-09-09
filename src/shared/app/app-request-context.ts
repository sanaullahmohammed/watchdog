import { requestContext } from '@fastify/request-context';

// Get request ID
function getRequestId(): string {
  // biome-ignore lint/style/noNonNullAssertion: request context is guaranteed inside the request lifecycle
  return requestContext.get('requestId')!;
}

export { getRequestId };
