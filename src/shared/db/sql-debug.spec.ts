import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import pino, { type LoggerOptions } from 'pino';
import postgres from 'postgres';
import {
  appLoggerOptions,
  isDatabaseError,
  LOG_REDACT_PATHS,
  LOG_SERIALIZERS,
  logMessageOf,
  REDACTED,
  scrubbedLoggerOptions,
  serializeError,
  serializeRequest,
  sqlDebugOption,
} from '@/shared/db/sql-debug';
import { DatabaseErrorException } from '@/shared/exceptions';
import { captureLogs } from '@/shared/testing/logs';

const EMAIL = 'secret-subscriber@example.test';
const NUMBER = 987654321;
const OBJECT = { token: 'abc-xyz' };
const VALUES = [EMAIL, String(NUMBER), 'abc-xyz'];

function capture() {
  const received: unknown[][] = [];
  return {
    received,
    logger: {
      debug: (...args: unknown[]) => {
        received.push(args);
      },
    },
  };
}

describe('story 6.4: the req serializer', () => {
  const request = (url: string) => ({
    method: 'GET',
    url,
    headers: { 'accept-version': '1.0.0' },
    host: 'example.test',
    ip: '10.0.0.1',
    socket: { remotePort: 4321 },
  });

  it('cuts the query string and keeps the default fields', () => {
    assert.deepEqual(
      serializeRequest(request('/status/x/subscribers/confirm?token=abc&b=1')),
      {
        method: 'GET',
        url: '/status/x/subscribers/confirm',
        version: '1.0.0',
        host: 'example.test',
        remoteAddress: '10.0.0.1',
        remotePort: 4321,
      },
    );
    assert.equal(serializeRequest(request('/a?')).url, '/a');
    assert.equal(serializeRequest(request('/a')).url, '/a');
  });

  it('is on both logger option builders, and a caller req still wins', () => {
    const scrubbed = scrubbedLoggerOptions('info');
    assert.equal(scrubbed.serializers.req, serializeRequest);
    const app = appLoggerOptions(undefined, 'info') as {
      serializers: Record<string, unknown>;
    };
    assert.equal(app.serializers.req, serializeRequest);
    const merged = appLoggerOptions({ level: 'info' }, 'info') as {
      serializers: Record<string, unknown>;
    };
    assert.equal(merged.serializers.req, serializeRequest);
    const custom = () => ({ method: 'mine' });
    const own = appLoggerOptions(
      { level: 'info', serializers: { req: custom } as never },
      'info',
    ) as { serializers: Record<string, unknown> };
    assert.equal(own.serializers.req, custom);
  });
});

describe('sqlDebugOption', () => {
  it('logs the statement and a parameter count, never a value', () => {
    const { received, logger } = capture();
    const option = sqlDebugOption('debug', () => logger as never);
    assert.equal(typeof option.debug, 'function');
    if (typeof option.debug !== 'function') return;
    option.debug(3, '  insert into t (a, b, c) values ($1, $2, $3)  ', [
      EMAIL,
      NUMBER,
      OBJECT,
    ]);

    assert.deepEqual(received, [
      [
        {
          connection: 3,
          statement: 'insert into t (a, b, c) values ($1, $2, $3)',
          parameterCount: 3,
        },
        'SQL',
      ],
    ]);
    const text = JSON.stringify(received);
    for (const value of VALUES) assert.ok(!text.includes(value));
  });

  it('counts zero for a statement with no values', () => {
    const { received, logger } = capture();
    const option = sqlDebugOption('debug', () => logger as never);
    if (typeof option.debug !== 'function') return assert.fail();
    option.debug(1, 'select 1', []);
    assert.equal(
      (received[0][0] as { parameterCount: number }).parameterCount,
      0,
    );
  });

  for (const level of ['info', 'warn', 'error']) {
    it(`turns debug off at ${level}`, () => {
      let made = false;
      const option = sqlDebugOption(level, () => {
        made = true;
        return capture().logger as never;
      });
      assert.deepEqual(option, { debug: false });
      assert.equal(made, false);
    });
  }
});

describe('LOG_REDACT_PATHS', () => {
  it('keeps parameters and args off a logged error', () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: LOG_REDACT_PATHS },
      { write: (line: string) => lines.push(line) },
    );
    const make = () =>
      Object.assign(new Error('boom'), {
        parameters: [EMAIL, NUMBER, OBJECT],
        args: [EMAIL, NUMBER, OBJECT],
      });
    logger.error({ err: make() }, 'one');
    logger.error({ error: make() }, 'two');

    assert.equal(lines.length, 2);
    for (const line of lines) {
      for (const value of VALUES) assert.ok(!line.includes(value), line);
    }
  });
});

describe('appLoggerOptions', () => {
  it('keeps false false', () => {
    assert.equal(appLoggerOptions(false, 'info'), false);
  });

  for (const override of [undefined, true]) {
    it(`gives the default for ${String(override)}`, () => {
      assert.deepEqual(
        appLoggerOptions(override, 'warn'),
        scrubbedLoggerOptions('warn'),
      );
    });
  }

  it('merges an object override and still redacts', () => {
    const stream = { write: () => {} };
    const result = appLoggerOptions({ level: 'error', stream }, 'info') as {
      level: string;
      stream: unknown;
      redact: { paths: string[] };
    };
    assert.equal(result.level, 'error');
    assert.equal(result.stream, stream);
    assert.deepEqual(result.redact.paths, LOG_REDACT_PATHS);
  });

  it("keeps a caller's serializers but always scrubs err and error", () => {
    const req = () => 'mine';
    const err = () => 'not the scrub';
    const result = appLoggerOptions(
      { serializers: { req, err, error: err } as never },
      'info',
    ) as { serializers: Record<string, unknown> };
    assert.equal(result.serializers.req, req);
    assert.equal(result.serializers.err, LOG_SERIALIZERS.err);
    assert.equal(result.serializers.error, LOG_SERIALIZERS.error);
  });

  it("runs a caller's logMethod hook first, then the scrub", () => {
    const logs = captureLogs();
    const seen: unknown[][] = [];
    const options = appLoggerOptions(
      {
        stream: logs.stream,
        hooks: {
          logMethod(args, method) {
            seen.push(args);
            method.apply(this, args);
          },
        },
      },
      'info',
    ) as LoggerOptions & { stream: { write: (line: string) => void } };
    const log = pino(options, options.stream);
    log.error(postgresError());

    assert.equal(seen.length, 1, 'the caller hook ran');
    assert.equal(logs.entries()[0]?.msg, 'Database error 23505');
    assertNoSecret(logs.lines);
  });

  it('joins a caller redact array with the shared paths', () => {
    const result = appLoggerOptions({ redact: ['mine'] }, 'info') as {
      redact: { paths: string[] };
    };
    assert.deepEqual(result.redact.paths, [...LOG_REDACT_PATHS, 'mine']);
  });

  it('joins a caller redact object, keeping its other options', () => {
    const result = appLoggerOptions(
      { redact: { paths: ['mine'], censor: 'X' } },
      'info',
    ) as { redact: { paths: string[]; censor: string } };
    assert.deepEqual(result.redact.paths, [...LOG_REDACT_PATHS, 'mine']);
    assert.equal(result.redact.censor, 'X');
  });
});

/*
 * Story 6.1: a logged database error prints none of the values it carries.
 * Each field gets its own secret, so a test names the one that leaked.
 */

const SECRET = {
  message: 'secret-in-message@example.test',
  detail: 'secret-in-detail@example.test',
  where: 'secret-in-where@example.test',
  hint: 'secret-in-hint@example.test',
  internalQuery: 'secret-in-internal-query@example.test',
  pgMessage: 'secret-in-pg-message@example.test',
  pgDetail: 'secret-in-pg-detail@example.test',
  pgInternalQuery: 'secret-in-pg-internal-query@example.test',
  parameters: 'secret-in-parameters@example.test',
  args: 'secret-in-args@example.test',
};

function assertNoSecret(lines: readonly string[]) {
  const text = lines.join('\n');
  for (const [field, secret] of Object.entries(SECRET)) {
    assert.ok(!text.includes(secret), `${field} leaked: ${text}`);
  }
}

/** A `PostgresError` as postgres.js builds one: every field copied on. */
function postgresError(code = '23505') {
  return new postgres.PostgresError({
    message: `duplicate key value violates unique constraint "subscribers_email_key" ${SECRET.message}`,
    severity_local: 'ERROR',
    severity: 'ERROR',
    code,
    detail: `Key (email)=(${SECRET.detail}) already exists.`,
    where: `PL/pgSQL function f() line 3 at RAISE ${SECRET.where}`,
    hint: `Try ${SECRET.hint}`,
    internal_query: `select '${SECRET.internalQuery}'`,
    schema_name: 'public',
    table_name: 'subscribers',
    constraint_name: 'subscribers_email_key',
    file: 'nbtinsert.c',
    line: '666',
    routine: '_bt_check_unique',
  } as never);
}

/** A `pg` `DatabaseError`, named `error`, with a message over two lines. */
function pgError() {
  const error = new pg.DatabaseError(
    `invalid input syntax\nfor type integer: "${SECRET.pgMessage}"`,
    0,
    'error',
  );
  return Object.assign(error, {
    severity: 'ERROR',
    code: '22P02',
    detail: `Value ${SECRET.pgDetail}`,
    internalQuery: `select '${SECRET.pgInternalQuery}'`,
    routine: 'pg_strtoint32_safe',
  });
}

/** What postgres.js adds to a failed query's error in debug mode. */
function withValues<T extends object>(error: T): T {
  return Object.assign(error, {
    parameters: [SECRET.parameters],
    args: [SECRET.args],
  });
}

function scrubbedLog() {
  const logs = captureLogs();
  return { logs, log: pino(scrubbedLoggerOptions('info'), logs.stream) };
}

describe('isDatabaseError', () => {
  it('knows a postgres.js and a pg error, and nothing else', () => {
    assert.equal(isDatabaseError(postgresError()), true);
    assert.equal(isDatabaseError(pgError()), true);
    assert.equal(isDatabaseError(new Error('x')), false);
    // postgres.js's own connection errors carry a code but no severity.
    assert.equal(
      isDatabaseError(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'CONNECTION_REFUSED',
        }),
      ),
      false,
    );
    assert.equal(
      isDatabaseError({ severity: 'ERROR', code: 'not-sqlstate' }),
      false,
    );
  });
});

describe('logMessageOf', () => {
  it('names a database error by its code, anything else by its message', () => {
    assert.equal(logMessageOf(postgresError()), 'Database error 23505');
    assert.equal(logMessageOf(pgError()), 'Database error 22P02');
    assert.equal(logMessageOf(new Error('plain')), 'plain');
  });
});

describe('the error serializer (story 6.1)', () => {
  for (const key of ['err', 'error'] as const) {
    it(`scrubs a postgres.js error logged as ${key}`, () => {
      const { logs, log } = scrubbedLog();
      log.error({ [key]: postgresError() }, 'failed');

      assertNoSecret(logs.lines);
      const logged = logs.entries()[0]?.[key] as Record<string, unknown>;
      assert.equal(logged.type, 'PostgresError');
      assert.equal(logged.code, '23505');
      assert.equal(logged.constraint_name, 'subscribers_email_key');
      assert.equal(logged.table_name, 'subscribers');
      assert.equal(logged.routine, '_bt_check_unique');
      for (const field of [
        'message',
        'detail',
        'where',
        'hint',
        'internal_query',
      ]) {
        assert.equal(logged[field], REDACTED, field);
      }
      assert.match(String(logged.stack), /^PostgresError: \[Redacted\]\n/);
      assert.match(String(logged.stack), /\n {4}at /, 'the frames remain');
    });
  }

  it('scrubs a pg error, its multi-line message included in the stack', () => {
    const { logs, log } = scrubbedLog();
    log.error({ err: pgError() }, 'failed');

    assertNoSecret(logs.lines);
    const logged = logs.entries()[0]?.err as Record<string, unknown>;
    assert.equal(logged.code, '22P02');
    assert.equal(logged.name, 'error');
    assert.equal(logged.message, REDACTED);
    assert.equal(logged.detail, REDACTED);
    assert.equal(logged.internalQuery, REDACTED);
    assert.match(String(logged.stack), /\[Redacted\]\n {4}at /);
  });

  it('keeps the shape: type, message, stack, then the other fields', () => {
    const serialized = serializeError(postgresError()) as object;
    assert.deepEqual(Object.keys(serialized).slice(0, 3), [
      'type',
      'message',
      'stack',
    ]);
  });

  it('scrubs a database error under any other key', () => {
    const { logs, log } = scrubbedLog();
    log.error({ reason: postgresError(), other: 1 }, 'x');

    assertNoSecret(logs.lines);
    const entry = logs.entries()[0];
    assert.equal(entry?.msg, 'x');
    assert.equal(entry?.other, 1);
    assert.equal((entry?.reason as { code?: string }).code, '23505');
  });

  it('never makes a database error the message of a bare error', () => {
    const { logs, log } = scrubbedLog();
    log.error(postgresError());
    log.error({ err: postgresError() });
    log.error({ error: pgError() });
    log.error(pgError(), 'given');
    log.error({ err: postgresError() }, postgresError().message);

    assertNoSecret(logs.lines);
    assert.deepEqual(
      logs.entries().map((entry) => entry.msg),
      [
        'Database error 23505',
        'Database error 23505',
        undefined, // pino gives `{ error }` no message of its own
        'given',
        'Database error 23505',
      ],
    );
    assert.equal((logs.entries()[0]?.err as { code?: string }).code, '23505');
  });

  it('scrubs a database error as a cause', () => {
    const { logs, log } = scrubbedLog();
    log.error({ err: new Error('wrapped', { cause: postgresError() }) }, 'x');

    assertNoSecret(logs.lines);
    const logged = logs.entries()[0]?.err as Record<string, unknown>;
    assert.equal(logged.message, 'wrapped', 'not folded into the parent');
    assert.ok(!String(logged.stack).includes('caused by'));
    assert.equal((logged.cause as { code?: string }).code, '23505');
  });

  it('scrubs a database error held by a property', () => {
    const { logs, log } = scrubbedLog();
    const error = Object.assign(new Error('outer'), {
      inner: pgError(),
      nested: { list: [postgresError('23503')] },
    });
    log.error({ err: error }, 'x');

    assertNoSecret(logs.lines);
    const logged = logs.entries()[0]?.err as {
      inner: { code: string };
      nested: { list: { code: string }[] };
    };
    assert.equal(logged.inner.code, '22P02');
    assert.equal(logged.nested.list[0]?.code, '23503');
  });

  it("scrubs an AggregateError's members", () => {
    const { logs, log } = scrubbedLog();
    log.error(
      { err: new AggregateError([postgresError(), pgError()], 'both') },
      'x',
    );

    assertNoSecret(logs.lines);
    const logged = logs.entries()[0]?.err as {
      message: string;
      aggregateErrors: { code: string }[];
    };
    assert.equal(logged.message, 'both');
    assert.deepEqual(
      logged.aggregateErrors.map((member) => member.code),
      ['23505', '22P02'],
    );
  });

  it('redacts parameters and args on any error, at any depth', () => {
    const { logs, log } = scrubbedLog();
    const plain = withValues(new Error('plain'));
    log.error({ err: plain }, 'top');
    log.error({ reason: withValues(new Error('other key')) }, 'other');
    log.error(
      { err: new Error('outer', { cause: withValues(postgresError()) }) },
      'cause',
    );
    log.error(
      { err: new AggregateError([withValues(new Error('member'))]) },
      'aggregate',
    );
    // Not through pino's redact paths: the serializer alone. The plain object
    // is walked as one; the error inside it is scrubbed.
    log.error({ err: { message: 'deep', inner: withValues(pgError()) } }, 'x');

    assertNoSecret(logs.lines);
    assert.equal(
      (logs.entries()[0]?.err as { parameters?: unknown }).parameters,
      REDACTED,
    );
    const deep = logs.entries()[4]?.err as Record<string, unknown>;
    assert.equal(deep.message, 'deep');
    assert.equal(deep.type, undefined, 'not reshaped into an error');
    assert.equal((deep.inner as { code?: string }).code, '22P02');
  });

  it('keeps the shape of a domain object that has a message', () => {
    const { logs, log } = scrubbedLog();
    const update = {
      id: 'u-1',
      message: 'We are investigating.',
      status: 'investigating',
      services: [{ id: 's-1', message: 'degraded' }],
    };
    log.info({ err: update, update }, 'x');

    const entry = logs.entries()[0];
    assert.deepEqual(entry?.err, update);
    assert.deepEqual(entry?.update, update);
    assert.equal(entry?.msg, 'x');
  });

  it('scrubs a database error nested in any top-level array or object', () => {
    const { logs, log } = scrubbedLog();
    log.error({ failures: [postgresError()] }, 'list');
    log.error({ job: { id: 'j-1', lastError: pgError() } }, 'object');

    assertNoSecret(logs.lines);
    const [list, object] = logs.entries();
    assert.equal((list?.failures as { code: string }[])[0]?.code, '23505');
    const job = object?.job as { id: string; lastError: { code: string } };
    assert.equal(job.id, 'j-1');
    assert.equal(job.lastError.code, '22P02');
  });

  it('redacts a database error quoted inside a message', () => {
    const { logs, log } = scrubbedLog();
    const error = postgresError();
    log.error({ err: error }, `insert failed: ${error.message}`);
    log.error({ error }, `insert failed: ${error.message}!`);
    log.error({ reason: error }, `again: ${error.message}`);
    log.error(error, `bare: ${error.message}`);

    assertNoSecret(logs.lines);
    assert.deepEqual(
      logs.entries().map((entry) => entry.msg),
      [
        `insert failed: ${REDACTED}`,
        `insert failed: ${REDACTED}!`,
        `again: ${REDACTED}`,
        `bare: ${REDACTED}`,
      ],
    );
  });

  it('redacts the stack header of a database error whose message changed', () => {
    const { logs, log } = scrubbedLog();
    const error = postgresError();
    // V8 renders the stack on first read; postgres.js reads it in queryError,
    // so the header keeps the original message from then on.
    assert.ok(error.stack?.includes(SECRET.message));
    error.message = `while saving: ${error.message}`;
    log.error({ err: error }, 'x');

    assertNoSecret(logs.lines);
    const stack = String((logs.entries()[0]?.err as { stack?: unknown }).stack);
    assert.match(stack, /^PostgresError: \[Redacted\]\n {4}at /);
  });

  it('falls back to replacing the message in a stack with no frames', () => {
    const error = pgError();
    error.stack = `error: ${error.message}`;
    const serialized = serializeError(error) as { stack: string };
    assert.equal(serialized.stack, `error: ${REDACTED}`);
  });

  it('prints a non-database error as it is', () => {
    const { logs, log } = scrubbedLog();
    const error = Object.assign(new Error('the database went away'), {
      detail: 'not a database error, so not redacted',
      code: 'CONNECTION_REFUSED',
    });
    log.error({ err: error }, 'x');

    const logged = logs.entries()[0]?.err as Record<string, unknown>;
    assert.equal(logged.message, 'the database went away');
    assert.equal(logged.stack, error.stack);
    assert.equal(logged.detail, 'not a database error, so not redacted');
    assert.equal(logged.code, 'CONNECTION_REFUSED');
  });

  it('survives a cycle and stops at depth 8', () => {
    const cyclic = new Error('cyclic') as Error & { self?: unknown };
    cyclic.cause = cyclic;
    cyclic.self = { back: cyclic };
    const serialized = serializeError(cyclic) as Record<string, unknown>;
    assert.equal(serialized.cause, '[Circular]');
    assert.deepEqual(serialized.self, { back: '[Circular]' });

    let deep: Error = postgresError();
    for (let level = 0; level < 20; level += 1) {
      deep = new Error(`level ${level}`, { cause: deep });
    }
    const text = JSON.stringify(serializeError(deep));
    assert.ok(text.includes('[Truncated]'));
    assertNoSecret([text]);
    let depth = 0;
    let node = serializeError(deep) as { cause?: unknown } | string;
    while (typeof node === 'object' && node !== null) {
      depth += 1;
      node = node.cause as typeof node;
    }
    assert.equal(depth, 8, 'eight levels serialized, then truncated');
  });

  it('scrubs an ExceptionBase, logged and through toJSON', () => {
    const { logs, log } = scrubbedLog();
    const exception = new DatabaseErrorException(
      'Database error',
      withValues(postgresError()),
    );
    log.error({ err: exception }, 'x');
    const json = exception.toJSON();

    assertNoSecret([...logs.lines, JSON.stringify(json)]);
    assert.equal(typeof json.cause, 'string');
    assert.equal(JSON.parse(json.cause ?? '').code, '23505');
    assert.equal(
      new DatabaseErrorException('no cause').toJSON().cause,
      undefined,
    );
  });

  it('applies the scrub through the default app logger options', () => {
    const logs = captureLogs();
    const log = pino(
      appLoggerOptions(undefined, 'info') as LoggerOptions,
      logs.stream,
    );
    log.error(postgresError());
    log.error({ reason: withValues(pgError()) }, 'x');

    assertNoSecret(logs.lines);
    assert.equal(logs.entries()[0]?.msg, 'Database error 23505');
  });

  it('applies the scrub to child loggers', () => {
    const { logs, log } = scrubbedLog();
    log.child({ reqId: 'r' }).error({ cause: postgresError() });

    assertNoSecret(logs.lines);
  });
});
