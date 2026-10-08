import type { FastifyInstance } from 'fastify';

export type GraphqlError = {
  message: string;
  extensions?: { code?: string };
};

export type GraphqlResult = {
  statusCode: number;
  body: { data: Record<string, unknown> | null; errors?: GraphqlError[] };
};

/**
 * Sends one GraphQL operation to `/graphql` over HTTP with
 * `content-type: application/json`, and the cookie only when one is given.
 */
export async function gql(
  app: FastifyInstance,
  query: string,
  options: { variables?: object; cookie?: string } = {},
): Promise<GraphqlResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.cookie) headers.cookie = options.cookie;
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers,
    payload: { query, variables: options.variables },
  });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as GraphqlResult['body'],
  };
}
