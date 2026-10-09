import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

export type GraphqlError = {
  message: string;
  extensions?: { code?: string };
};

export type GraphqlResult<T = Record<string, unknown>> = {
  statusCode: number;
  body: { data: T | null; errors?: GraphqlError[] };
};

export type GraphqlOptions = {
  variables?: object;
  cookie?: string;
  headers?: Record<string, string>;
};

/**
 * Sends one GraphQL operation to `/graphql` and returns the raw inject
 * response, unparsed. `content-type: application/json` is always sent; the
 * cookie only when one is given, and `headers` are added after both.
 */
export function gqlResponse(
  app: FastifyInstance,
  query: string,
  options: GraphqlOptions = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.cookie) headers.cookie = options.cookie;
  Object.assign(headers, options.headers);
  return app.inject({
    method: 'POST',
    url: '/graphql',
    headers,
    payload: { query, variables: options.variables },
  });
}

/**
 * Sends one GraphQL operation over HTTP and returns the status with the
 * parsed body. `T` types `data`.
 */
export async function gql<T = Record<string, unknown>>(
  app: FastifyInstance,
  query: string,
  options: GraphqlOptions = {},
): Promise<GraphqlResult<T>> {
  const response = await gqlResponse(app, query, options);
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as GraphqlResult<T>['body'],
  };
}

/** Sends an operation, asserts the response has no `errors`, returns `data`. */
export async function gqlData<T = Record<string, unknown>>(
  app: FastifyInstance,
  query: string,
  options: GraphqlOptions = {},
): Promise<T> {
  const { statusCode, body } = await gql<T>(app, query, options);
  const detail = `status ${statusCode}: ${JSON.stringify(body)}`;
  assert.equal(body.errors, undefined, detail);
  assert.notEqual(body.data, null, detail);
  return body.data as T;
}
