import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { GraphQLError } from 'graphql';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { gqlResponse } from '@/shared/testing/graphql';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Epic 3 retrospective, action item 7 (R-6): GraphQL tells a caller what REST
 * does when something fails, and no more.
 */

const tag = `gqlerr-${randomBytes(4).toString('hex')}`;

/** What a database connection failure says, host and port included. */
const INTERNAL = 'connect ECONNREFUSED 10.20.30.40:5432 (db.internal)';

let app: FastifyInstance;
let userId = '';
let orgId = '';
let cookie = '';
const logLines: string[] = [];

const PAGE_QUERY =
  'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { overallStatus } }';

/** Makes the page's first read fail the way a lost database would. */
async function withBrokenPage<T>(run: () => Promise<T>): Promise<T> {
  const repository = app.diContainer.resolve(
    'publicStatusRepository' as never,
  ) as { listPublicServices: () => Promise<unknown> };
  const listPublicServices = repository.listPublicServices;
  repository.listPublicServices = async () => {
    throw new Error(INTERNAL);
  };
  try {
    return await run();
  } finally {
    repository.listPublicServices = listPublicServices;
  }
}

/** An `AggregateError` built the way Node builds one when every address refuses. */
function buildAggregate(): AggregateError {
  const member = (address: string) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:6543`), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
      address,
      port: 6543,
    });
  const aggregate = new AggregateError([
    member('10.20.30.40'),
    member('fd00::40'),
  ]);
  return Object.assign(aggregate, { code: 'ECONNREFUSED' });
}

const LEAKS = [
  '10.20.30.40',
  'fd00::40',
  '6543',
  'ECONNREFUSED',
  'AggregateError',
];

function assertNoLeak(body: string) {
  for (const leak of LEAKS) {
    assert.ok(!body.includes(leak), `body leaks ${leak}: ${body}`);
  }
}

/** Makes one method of a DI singleton throw `error`, and restores it. */
async function withBroken<T>(
  repositoryName: string,
  method: string,
  error: Error,
  run: () => Promise<T>,
): Promise<T> {
  const repository = app.diContainer.resolve(repositoryName as never) as Record<
    string,
    unknown
  >;
  const original = repository[method];
  repository[method] = async () => {
    throw error;
  };
  try {
    return await run();
  } finally {
    repository[method] = original;
  }
}

function loggedUnder(correlationId: string) {
  return logLines
    .map((line) => JSON.parse(line))
    .find((entry) => entry.correlationId === correlationId);
}

function assertMaskedGraphql(result: { statusCode: number; body: string }) {
  assert.equal(result.statusCode, 500, result.body);
  assertNoLeak(result.body);
  const body = JSON.parse(result.body);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].message, 'Internal Server Error');
  const correlationId = body.errors[0].extensions?.correlationId;
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  const logged = loggedUnder(correlationId);
  assert.ok(logged, 'the original is logged under the correlation id');
  assert.equal(logged.level, 50);
  assert.ok(logged.err.stack, 'with its stack, since the server broke');
  return { body, logged };
}

function assertAggregateLogged(logged: {
  msg: string;
  err: { aggregateErrors?: unknown[] };
}) {
  assert.equal(logged.err.aggregateErrors?.length, 2);
  for (const leak of LEAKS) {
    assert.ok(!logged.msg.includes(leak), `log msg leaks ${leak}`);
  }
}

function assertMaskedRest(response: { statusCode: number; body: string }) {
  assert.equal(response.statusCode, 500, response.body);
  assertNoLeak(response.body);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.message, 'Internal Server Error');
  assert.match(parsed.correlationId, /^[0-9a-f-]{36}$/);
}

describe('GraphQL errors, masked the way REST masks them (retrospective R-6)', () => {
  before(async () => {
    app = await buildApp({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) },
      },
    });
    await app.ready();
    app.graphql.extendSchema('extend type Query { dbErrorProbe: String! }');
    app.graphql.defineResolvers({
      Query: {
        dbErrorProbe: async () => {
          const [row] = await sql`select 'x'::uuid as value`;
          return String(row.value);
        },
      },
    });
    ({ userId, orgId, cookie } = await signUpWithOrg(app, tag));
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('masks an unexpected failure and logs the original under the id it returns', async () => {
    const result = await withBrokenPage(() =>
      gqlResponse(app, PAGE_QUERY, { variables: { slug: tag } }),
    );

    assert.equal(result.statusCode, 500, result.body);
    const body = JSON.parse(result.body);
    const correlationId = body.errors?.[0]?.extensions?.correlationId;
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
    // The whole body: the fault's text, host and port are nowhere in it.
    assert.deepEqual(body, {
      data: null,
      errors: [
        {
          message: 'Internal Server Error',
          locations: [
            { line: 1, column: PAGE_QUERY.indexOf('publicStatusPage') + 1 },
          ],
          path: ['publicStatusPage'],
          extensions: { correlationId },
        },
      ],
    });

    // What was hidden from the caller is in the log, findable by that id.
    const logged = logLines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.correlationId === correlationId);
    assert.ok(logged, 'the original is logged under the correlation id');
    assert.equal(logged.level, 50);
    assert.equal(logged.err.message, INTERNAL);
    assert.ok(logged.err.stack, 'with its stack, since the server broke');
  });

  it('answers the same failure over REST the same way', async () => {
    const response = await withBrokenPage(() =>
      app.inject({ method: 'GET', url: `/status/${tag}` }),
    );

    assert.equal(response.statusCode, 500, response.body);
    const { correlationId, ...rest } = JSON.parse(response.body);
    assert.deepEqual(rest, {
      statusCode: 500,
      message: 'Internal Server Error',
      error: 'Internal Server Error',
    });
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
  });

  it("passes the application's own exceptions through", async () => {
    const result = await gqlResponse(app, PAGE_QUERY, {
      variables: { slug: `${tag}-nobody` },
    });

    assert.equal(result.statusCode, 404, result.body);
    assert.deepEqual(
      JSON.parse(result.body).errors.map(
        (error: { message: string; extensions?: unknown }) => [
          error.message,
          error.extensions,
        ],
      ),
      [['Status page not found', undefined]],
    );
  });

  it("passes a resolver's own GraphQL error through, extensions and all", async () => {
    // How every authenticated resolver refuses an anonymous caller.
    const result = await gqlResponse(app, 'query { services { id } }');

    assert.deepEqual(
      JSON.parse(result.body).errors.map(
        (error: { message: string; extensions?: unknown }) => [
          error.message,
          error.extensions,
        ],
      ),
      [['Authentication required', { code: 'UNAUTHENTICATED' }]],
    );
  });

  it("passes GraphQL's own errors about the query through", async () => {
    const result = await gqlResponse(
      app,
      'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { nope } }',
      { variables: { slug: tag } },
    );

    assert.equal(result.statusCode, 400, result.body);
    assert.match(
      JSON.parse(result.body).errors[0].message,
      /^Cannot query field "nope"/,
    );
  });

  it('masks a genuine database error and logs the original under the id it returns', async () => {
    // A test-only field, defined on this app instance alone, runs SQL that
    // Postgres refuses. The driver's own PostgresError reaches the real
    // GraphQL error path, with no dependence on a product bug. It is
    // non-null, because mercurius answers 500 only when `data` is null.
    const result = await gqlResponse(app, 'query { dbErrorProbe }');

    assert.equal(result.statusCode, 500, result.body);
    assert.ok(!result.body.includes('invalid input syntax'), result.body);
    const body = JSON.parse(result.body);
    assert.equal(body.data, null);
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].message, 'Internal Server Error');
    const correlationId = body.errors[0].extensions?.correlationId;
    assert.match(correlationId, /^[0-9a-f-]{36}$/);

    const logged = logLines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.correlationId === correlationId);
    assert.ok(logged, 'the original is logged under the correlation id');
    assert.equal(logged.level, 50);
    // Story 6.1: a database error's text can quote a value, so the line names
    // it by its code and the serializer redacts its message.
    assert.equal(logged.msg, 'Database error 22P02');
    assert.equal(logged.err.code, '22P02');
    assert.equal(logged.err.message, '[Redacted]');
    assert.ok(logged.err.stack, 'with its stack, since the server broke');
  });

  it('masks an aggregate error from the anonymous page', async () => {
    const result = await withBroken(
      'publicStatusRepository',
      'listPublicServices',
      buildAggregate(),
      () => gqlResponse(app, PAGE_QUERY, { variables: { slug: tag } }),
    );
    const { body, logged } = assertMaskedGraphql(result);
    const correlationId = body.errors[0].extensions.correlationId;
    assert.deepEqual(body, {
      data: null,
      errors: [
        {
          message: 'Internal Server Error',
          locations: [
            { line: 1, column: PAGE_QUERY.indexOf('publicStatusPage') + 1 },
          ],
          path: ['publicStatusPage'],
          extensions: { correlationId },
        },
      ],
    });
    assertAggregateLogged(logged);
  });

  it('masks the same aggregate over REST', async () => {
    const response = await withBroken(
      'publicStatusRepository',
      'listPublicServices',
      buildAggregate(),
      () => app.inject({ method: 'GET', url: `/status/${tag}` }),
    );
    assertMaskedRest(response);
  });

  it('masks an aggregate error from an authenticated resolver', async () => {
    const result = await withBroken(
      'serviceRepository',
      'list',
      buildAggregate(),
      () => gqlResponse(app, 'query { services { id } }', { cookie }),
    );
    assertAggregateLogged(assertMaskedGraphql(result).logged);
  });

  it('masks the same aggregate over authenticated REST', async () => {
    const response = await withBroken(
      'serviceRepository',
      'list',
      buildAggregate(),
      () =>
        app.inject({
          method: 'GET',
          url: '/api/v1/services',
          headers: { cookie },
        }),
    );
    assertMaskedRest(response);
  });

  it('masks an error that merely copies the validation code', async () => {
    const fake = Object.assign(new Error('boom'), {
      code: 'MER_ERR_GQL_VALIDATION',
      errors: [new Error('connect ECONNREFUSED 10.20.30.40:6543')],
    });
    const result = await withBroken(
      'publicStatusRepository',
      'listPublicServices',
      fake,
      () => gqlResponse(app, PAGE_QUERY, { variables: { slug: tag } }),
    );
    assertMaskedGraphql(result);
  });

  it('masks an empty aggregate, a GraphQLError-only aggregate and copied codes', async () => {
    const leaky = () => new Error('connect ECONNREFUSED 10.20.30.40:6543');
    const faults: Error[] = [
      new AggregateError([]),
      new AggregateError([
        new GraphQLError('connect ECONNREFUSED 10.20.30.40:6543'),
      ]),
      Object.assign(new Error('boom'), {
        code: 'MER_ERR_GQL_VALIDATION',
        errors: [],
      }),
      Object.assign(new Error('boom'), {
        code: 'MER_ERR_METHOD_NOT_ALLOWED',
        errors: [leaky()],
      }),
    ];
    for (const fault of faults) {
      const result = await withBroken(
        'publicStatusRepository',
        'listPublicServices',
        fault,
        () => gqlResponse(app, PAGE_QUERY, { variables: { slug: tag } }),
      );
      assertMaskedGraphql(result);
    }
  });

  it('still tells the caller about a bad argument type', async () => {
    const result = await gqlResponse(
      app,
      'query { services(filter: 5) { id } }',
      {
        cookie,
      },
    );
    assert.equal(result.statusCode, 400, result.body);
    assert.match(JSON.parse(result.body).errors[0].message, /ServiceFilter/);
  });

  it('still tells the caller about a bad variable', async () => {
    const result = await gqlResponse(app, PAGE_QUERY, {
      variables: { slug: {} },
    });
    assert.equal(result.statusCode, 400, result.body);
    assert.match(
      JSON.parse(result.body).errors[0].message,
      /^Variable "\$slug" got invalid value/,
    );
  });

  it('answers a mutation sent by GET with 405 and its own message', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/graphql?query=mutation{__typename}',
    });
    assert.equal(result.statusCode, 405, result.body);
    assert.equal(
      JSON.parse(result.body).errors[0].message,
      'Operation cannot be performed via a GET request',
    );
    assert.ok(
      logLines
        .map((line) => JSON.parse(line))
        .some((entry) => entry.level === 30 && entry.statusCode === 405),
      'logged at info with the status the response carries',
    );
  });

  it("answers a bodyless POST with 400 and Fastify's own message", async () => {
    const result = await app.inject({ method: 'POST', url: '/graphql' });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(
      result.body,
      '{"data":null,"errors":[{"message":"body must be object"}]}',
    );
  });
});
