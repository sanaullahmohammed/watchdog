import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { env } from '@/config';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Epic 3 retrospective, action item 8 (AV-9, R-7): a failure is logged by who
 * caused it. Anonymous callers once wrote a level-50 line, stack and all, with
 * every miss.
 */

const tag = `errlog-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let userId = '';
let orgId = '';
const logLines: string[] = [];

type LogEntry = {
  level: number;
  msg: string;
  reqId?: string;
  correlationId?: string;
  statusCode?: number;
  err?: { stack?: string };
};

/** Fastify's own two lines for every request, which say nothing of failure. */
const ROUTINE = new Set(['incoming request', 'request completed']);

/**
 * Sends one request under its own id and returns every other line logged for
 * it: by the request logger, which binds `reqId`, or naming it as
 * `correlationId`. Matching on either is what lets a stray second line, such
 * as mercurius's default formatter logging on its own, show up here.
 */
async function logsOf(request: InjectOptions) {
  const id = randomUUID();
  const response = await app.inject({
    ...request,
    headers: { ...request.headers, 'request-id': id },
  });
  const entries = logLines
    .map((line) => JSON.parse(line) as LogEntry)
    .filter((entry) => entry.reqId === id || entry.correlationId === id)
    .filter((entry) => !ROUTINE.has(entry.msg));
  return { response, entries };
}

const graphql = (query: string): InjectOptions => ({
  method: 'POST',
  url: '/graphql',
  headers: { 'content-type': 'application/json' },
  payload: { query },
});

/** What each line said, and whether it carried a stack. */
const summary = (entries: LogEntry[]) =>
  entries.map((entry) => ({
    level: entry.level,
    msg: entry.msg,
    stack: Boolean(entry.err?.stack),
  }));

describe('Failures logged by who caused them (retrospective AV-9, R-7)', () => {
  before(async () => {
    app = await buildApp({
      logger: {
        level: 'info',
        stream: { write: (line: string) => logLines.push(line) },
      },
    });
    await app.ready();
    ({ userId, orgId } = await signUpWithOrg(app, tag));
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('logs anonymous misses at info with no stack, over both surfaces', async () => {
    // The retrospective's reproduction: three misses once wrote three
    // level-50 lines with stack traces.
    for (const slug of ['nobody', 'nobody-else', 'n'.repeat(150)]) {
      const { response, entries } = await logsOf({
        method: 'GET',
        url: `/status/${slug}`,
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(summary(entries), [
        { level: 30, msg: 'Status page not found', stack: false },
      ]);
    }

    const { entries } = await logsOf(
      graphql('{ publicStatusPage(orgSlug: "nobody") { overallStatus } }'),
    );
    // Exactly one line: mercurius's own formatter no longer adds its own.
    assert.deepEqual(summary(entries), [
      { level: 30, msg: 'Status page not found', stack: false },
    ]);
  });

  it('logs a refused credential at warn, over both surfaces', async () => {
    const rest = await logsOf({ method: 'GET', url: '/api/v1/services' });
    assert.equal(rest.response.statusCode, 401);
    assert.deepEqual(summary(rest.entries), [
      { level: 40, msg: 'Authentication required', stack: false },
    ]);

    const graph = await logsOf(graphql('{ services { id } }'));
    assert.deepEqual(summary(graph.entries), [
      { level: 40, msg: 'Authentication required', stack: false },
    ]);
  });

  it('answers a malformed body as the 400 it is, and logs it at info', async () => {
    // Fastify refuses this before any handler runs. It was a 500, logged at
    // error, on every POST route, for anyone.
    const { response, entries } = await logsOf({
      method: 'POST',
      url: '/api/v1/services',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });

    assert.equal(response.statusCode, 400, response.body);
    const { correlationId, ...rest } = JSON.parse(response.body);
    assert.deepEqual(rest, {
      statusCode: 400,
      message:
        "Body is not valid JSON but content-type is set to 'application/json'",
      error: 'Bad Request',
    });
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(summary(entries), [
      { level: 30, msg: rest.message, stack: false },
    ]);
  });

  it("logs GraphQL's own verdict on a query at info, once", async () => {
    const { response, entries } = await logsOf(graphql('{ nope }'));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(summary(entries), [
      { level: 30, msg: 'Graphql validation error', stack: false },
    ]);
  });

  it('still logs a server fault at error, with its stack', async () => {
    const repository = app.diContainer.resolve(
      'publicStatusRepository' as never,
    ) as { listPublicServices: () => Promise<unknown> };
    const listPublicServices = repository.listPublicServices;
    repository.listPublicServices = async () => {
      throw new Error('the database went away');
    };

    try {
      const { response, entries } = await logsOf({
        method: 'GET',
        url: `/status/${tag}`,
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(summary(entries), [
        { level: 50, msg: 'the database went away', stack: true },
      ]);
    } finally {
      repository.listPublicServices = listPublicServices;
    }
  });

  it('keeps parameters and args off a logged error, whatever logger the app has', async () => {
    const secret = `secret-subscriber-${tag}@example.test`;
    const make = () =>
      Object.assign(new Error('boom'), {
        parameters: [secret],
        args: [secret],
      });
    const lines: string[] = [];
    const stream = { write: (line: string) => lines.push(line) };
    // The default branch cannot take a stream; it is covered in sql-debug.spec.ts.
    const other = await buildApp({ logger: { level: 'info', stream } });
    try {
      for (const target of [app, other]) {
        const before = logLines.length;
        target.log.error({ err: make() }, 'as err');
        target.log.error({ error: make() }, 'as error');
        const written = target === app ? logLines.slice(before) : lines;
        assert.ok(written.length >= 2);
        for (const line of written) assert.ok(!line.includes(secret), line);
      }
    } finally {
      await other.close();
    }
  });

  it('gives the shared connection debug: false at a non-debug level', () => {
    assert.notEqual(env.log.level, 'debug');
    assert.equal(sql.options.debug, false);
  });
});
