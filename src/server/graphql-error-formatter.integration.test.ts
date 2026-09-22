import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Epic 3 retrospective, action item 7 (R-6): GraphQL tells a caller what REST
 * does when something fails, and no more.
 */

const tag = `gqlerr-${randomBytes(4).toString('hex')}`;

/** What a database connection failure says, host and port included. */
const INTERNAL = 'connect ECONNREFUSED 10.20.30.40:5432 (db.internal)';

let app: FastifyInstance;
let cookie = '';
let userId = '';
let orgId = '';
const logLines: string[] = [];

const PAGE_QUERY =
  'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { overallStatus } }';

async function gql(query: string, variables?: object, headers = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', ...headers },
    payload: { query, variables },
  });
  return { statusCode: response.statusCode, body: response.body };
}

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

describe('GraphQL errors, masked the way REST masks them (retrospective R-6)', () => {
  before(async () => {
    app = await buildApp({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) },
      },
    });
    await app.ready();
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('masks an unexpected failure and logs the original under the id it returns', async () => {
    const result = await withBrokenPage(() => gql(PAGE_QUERY, { slug: tag }));

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
    const result = await gql(PAGE_QUERY, { slug: `${tag}-nobody` });

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
    const result = await gql('query { services { id } }');

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
    const result = await gql(
      'query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { nope } }',
      { slug: tag },
    );

    assert.equal(result.statusCode, 400, result.body);
    assert.match(
      JSON.parse(result.body).errors[0].message,
      /^Cannot query field "nope"/,
    );
  });

  it('masks a database error a real resolver lets through, not only an injected one', async () => {
    // A malformed id reaches Postgres over GraphQL, where REST refuses it
    // with a 400 first. Its message once came back verbatim. Masked, it is a
    // 500, which misfiles a client mistake: the right answer is REST's 400,
    // and that is a separate fix. What this pins is that the text is gone.
    const result = await gql(
      'query { service(id: "not-a-uuid") { id } }',
      {},
      {
        cookie,
        origin: TEST_ORIGIN,
      },
    );

    assert.ok(!result.body.includes('invalid input syntax'), result.body);
    assert.equal(
      JSON.parse(result.body).errors[0].message,
      'Internal Server Error',
    );
  });
});
