import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { env } from '@/config';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { captureLogs, type LogEntry } from '@/shared/testing/logs';
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
const logs = captureLogs();

/** An address no other line in any suite holds, as a subscriber's would be. */
const address = `subscriber-${tag}@example.test`;

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
  const lines = logs.lines.filter((line) => {
    const entry = JSON.parse(line) as LogEntry;
    return entry.reqId === id || entry.correlationId === id;
  });
  const entries = lines
    .map((line) => JSON.parse(line) as LogEntry)
    .filter((entry) => !ROUTINE.has(entry.msg));
  return { response, entries, lines };
}

/**
 * Runs `query` in place of the public page's service read, so the request
 * fails with whatever real database error it raises.
 */
async function failingPublicPage(
  query: () => Promise<unknown>,
): Promise<Awaited<ReturnType<typeof logsOf>>> {
  const repository = app.diContainer.resolve(
    'publicStatusRepository' as never,
  ) as { listPublicServices: () => Promise<unknown> };
  const listPublicServices = repository.listPublicServices;
  repository.listPublicServices = query;
  try {
    return await logsOf({ method: 'GET', url: `/status/${tag}` });
  } finally {
    repository.listPublicServices = listPublicServices;
  }
}

/** A real database error whose message quotes `address`. */
const castFailure = () =>
  sql`select ${address}::int`.then(
    () => assert.fail('the cast succeeded'),
    (error: unknown) => error as Error,
  );

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
        stream: logs.stream,
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

  it('logs a malformed URL under /status once, at info, with no stack', async () => {
    const id = randomUUID();
    const response = await app.inject({
      method: 'GET',
      url: '/status/%E0',
      headers: { 'request-id': id },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().correlationId, id);
    const entries = logs
      .entries()
      .filter((e) => e.reqId === id || e.correlationId === id)
      .filter((e) => !ROUTINE.has(e.msg));
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0]?.level, 30);
    // Story 6.1: Fastify's own refusal logs its code, not its message.
    assert.equal(entries[0]?.msg, 'FST_ERR_BAD_URL');
    assert.equal(entries[0]?.err?.stack, undefined);
    assert.equal(entries[0]?.correlationId, id);
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
    // error, on every POST route, for anyone. Its parse error can quote the
    // body, so story 6.1 logs the refusal's code instead of its message.
    const { response, entries, lines } = await logsOf({
      method: 'POST',
      url: '/api/v1/services',
      headers: { 'content-type': 'application/json' },
      payload: `{"email": ${address}`,
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
      { level: 30, msg: 'FST_ERR_CTP_INVALID_JSON_BODY', stack: false },
    ]);
    for (const line of lines) assert.ok(!line.includes(address), line);
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

  it("keeps a unique violation's address out of its 500 line (story 6.1)", async () => {
    const { response, entries, lines } = await failingPublicPage(() =>
      sql.begin(async (transaction) => {
        // postgres.js's TransactionSql type drops the call signature.
        const tx = transaction as unknown as typeof sql;
        await tx`
          create temp table errlog_subscribers (
            email text constraint errlog_subscribers_email_key unique
          ) on commit drop
        `;
        await tx`insert into errlog_subscribers values (${address}), (${address})`;
      }),
    );

    assert.equal(response.statusCode, 500);
    for (const line of lines) assert.ok(!line.includes(address), line);
    assert.deepEqual(summary(entries), [
      { level: 50, msg: 'Database error 23505', stack: true },
    ]);
    const err = entries[0]?.err ?? {};
    assert.equal(err.code, '23505');
    assert.equal(err.constraint_name, 'errlog_subscribers_email_key');
    assert.equal(err.detail, '[Redacted]');
  });

  it("keeps an address quoted in a database error's message out of its 500 line", async () => {
    const { response, entries, lines } = await failingPublicPage(async () => {
      throw await castFailure();
    });

    assert.equal(response.statusCode, 500);
    for (const line of lines) assert.ok(!line.includes(address), line);
    assert.deepEqual(summary(entries), [
      { level: 50, msg: 'Database error 22P02', stack: true },
    ]);
    assert.equal(entries[0]?.err?.message, '[Redacted]');
  });

  it('keeps parameters and args off a logged error, whatever logger the app has', async () => {
    const secret = `secret-subscriber-${tag}@example.test`;
    const make = () =>
      Object.assign(new Error('boom'), {
        parameters: [secret],
        args: [secret],
      });
    // Story 6.1: real database errors, wrapped and aggregated, quoting
    // `address` in their messages.
    const database = await castFailure();
    const otherLogs = captureLogs();
    // The default branch cannot take a stream; it is covered in sql-debug.spec.ts.
    const other = await buildApp({
      logger: { level: 'info', stream: otherLogs.stream },
    });
    try {
      for (const target of [app, other]) {
        const captured = target === app ? logs : otherLogs;
        const before = captured.lines.length;
        target.log.error({ err: make() }, 'as err');
        target.log.error({ error: make() }, 'as error');
        target.log.error(
          { err: new Error('wrapped', { cause: database }) },
          'wrapped',
        );
        target.log.error(
          { err: new AggregateError([database], 'aggregate') },
          'aggregate',
        );
        target.log.error({ reason: database }, 'other key');
        target.log.error(database);
        const written = captured.lines.slice(before);
        assert.equal(written.length, 6);
        for (const line of written) {
          assert.ok(!line.includes(secret), line);
          assert.ok(!line.includes(address), line);
        }
        const [, , wrapped, aggregate, otherKey, bare] = written.map(
          (line) => JSON.parse(line) as LogEntry,
        );
        assert.equal((wrapped?.err?.cause as { code?: string }).code, '22P02');
        assert.equal(
          (aggregate?.err?.aggregateErrors as { code?: string }[])[0]?.code,
          '22P02',
        );
        assert.equal((otherKey?.reason as { code?: string }).code, '22P02');
        assert.equal(bare?.msg, 'Database error 22P02');
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
