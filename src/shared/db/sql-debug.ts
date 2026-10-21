import type { FastifyServerOptions } from 'fastify';
import type { Logger, LoggerOptions } from 'pino';

/**
 * Paths every application logger redacts. A database error from postgres.js
 * can carry the query's `parameters` and `args`; they hold values such as
 * incident text and, from Epic 6, subscriber addresses.
 */
export const LOG_REDACT_PATHS = [
  'headers.authorization',
  'err.parameters',
  'err.args',
  'error.parameters',
  'error.args',
];

/** What one SQL debug entry says: the statement and how many values, never the values. */
export function sqlDebugEntry(
  connection: number,
  statement: string,
  parameters: readonly unknown[],
) {
  return {
    connection,
    statement: statement.trim(),
    parameterCount: parameters.length,
  };
}

/**
 * The `debug` option for `postgres()`. An explicit `false` outside debug mode
 * also beats `PGDEBUG` and `?debug=`, and keeps postgres.js from making the
 * parameters on query errors enumerable.
 */
export function sqlDebugOption(
  level: string,
  makeLogger: () => Pick<Logger, 'debug'>,
):
  | { debug: false }
  | {
      debug: (
        connection: number,
        statement: string,
        parameters: unknown[],
      ) => void;
    } {
  if (level !== 'debug') return { debug: false };
  const logger = makeLogger();
  return {
    debug: (connection, statement, parameters) => {
      logger.debug(sqlDebugEntry(connection, statement, parameters), 'SQL');
    },
  };
}

/** What every scrubbed value is replaced with. */
export const REDACTED = '[Redacted]';

/**
 * Fields of a database error that can quote a value from the statement. Its
 * `message` can too; it is redacted where the serializer sets it.
 */
const DATABASE_VALUE_FIELDS = new Set([
  'detail',
  'where',
  'hint',
  'internal_query',
  'internalQuery',
]);

/** Fields of any error that can hold a query's values (postgres.js, debug). */
const VALUE_FIELDS = new Set(['parameters', 'args']);

/** How many levels of nested errors, objects and arrays are serialized. */
const MAX_DEPTH = 8;

type ErrorLike = { message: string } & Record<string, unknown>;
type DatabaseErrorLike = Record<string, unknown> & {
  severity: string;
  code: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * An error from Postgres: postgres.js's `PostgresError`, or `pg`'s
 * `DatabaseError` (Better Auth's pool). Both carry a string `severity` and a
 * five-character SQLSTATE `code`, and any of their text fields can quote a
 * value from the statement.
 */
export function isDatabaseError(value: unknown): value is DatabaseErrorLike {
  return (
    isObject(value) &&
    typeof value.severity === 'string' &&
    typeof value.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(value.code)
  );
}

/**
 * An `Error`, or a database error however it was built. A plain object with a
 * `message`, such as an incident update, is not one: it is walked as a plain
 * object and keeps its shape.
 */
function isErrorLike(value: unknown): value is ErrorLike {
  return value instanceof Error || isDatabaseError(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The text a log line may carry as `msg` for an error: a database error's
 * SQLSTATE, never its message, which can quote a value.
 */
export function logMessageOf(error: unknown): string {
  if (isDatabaseError(error)) return `Database error ${error.code}`;
  if (isErrorLike(error)) return error.message;
  return String(error);
}

function scrubValue(value: unknown, depth: number, path: Set<object>): unknown {
  if (!isObject(value)) return value;
  if (path.has(value)) return '[Circular]';
  const isError = isErrorLike(value);
  if (!isError && !Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth > MAX_DEPTH) return '[Truncated]';

  path.add(value);
  try {
    if (isError) return serializeErrorAt(value, depth, path);
    if (Array.isArray(value)) {
      return value.map((item) => scrubValue(item, depth + 1, path));
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = scrubValue(value[key], depth + 1, path);
    }
    return copy;
  } finally {
    path.delete(value);
  }
}

/**
 * A database error's stack without its message. The header, everything before
 * the first frame, is replaced whole: the message may have been changed after
 * the stack was captured, so the current one need not appear in it. A stack
 * with no frame line falls back to replacing the current message.
 */
function scrubbedStack(error: ErrorLike, message: string): unknown {
  const { stack } = error;
  if (typeof stack !== 'string') return stack;
  const frame = /\n\s+at /.exec(stack);
  if (frame)
    return `${String(error.name)}: ${REDACTED}${stack.slice(frame.index)}`;
  return message === '' ? stack : stack.replaceAll(message, REDACTED);
}

function serializeErrorAt(
  error: ErrorLike,
  depth: number,
  path: Set<object>,
): Record<string, unknown> {
  const database = isDatabaseError(error);
  const message = typeof error.message === 'string' ? error.message : '';
  const ctor = (error as { constructor?: unknown }).constructor;

  const out: Record<string, unknown> = {
    type: typeof ctor === 'function' && ctor.name ? ctor.name : error.name,
    message: database ? REDACTED : error.message,
    stack: database ? scrubbedStack(error, message) : error.stack,
  };

  const members = Array.isArray(error.errors) ? error.errors : undefined;
  if (members) {
    out.aggregateErrors = members.map((member) =>
      scrubValue(member, depth + 1, path),
    );
  }

  for (const key of Object.keys(error)) {
    if (key in out || key === 'cause') continue;
    if (key === 'errors' && members) continue;
    if (VALUE_FIELDS.has(key) || (database && DATABASE_VALUE_FIELDS.has(key))) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(error[key], depth + 1, path);
  }

  // `new Error(m, { cause })` makes `cause` non-enumerable; it is serialized
  // either way, as its own object rather than folded into this message.
  if ('cause' in error && error.cause !== undefined) {
    out.cause = scrubValue(error.cause, depth + 1, path);
  }

  return out;
}

/**
 * The `err` and `error` serializer of every application logger. It replaces
 * pino's, which folds a cause's message and stack into its parent's and copies
 * every field as it is.
 *
 * Keeps pino's shape: `type`, `message`, `stack`, then the other own
 * enumerable properties. A database error's `message`, `detail`, `where`,
 * `hint`, `internal_query` and `internalQuery`, and that message inside its
 * stack, become `[Redacted]`; its code, constraint, table, routine and the
 * rest of its stack still print. `parameters` and `args` are redacted on any
 * error. A `cause` is serialized under `cause`, and `AggregateError` members
 * under `aggregateErrors`, each scrubbed the same way, to a depth of 8.
 * Anything that is not error-like comes back as it is.
 */
export function serializeError(value: unknown): unknown {
  return scrubValue(value, 1, new Set());
}

/** The shape Fastify's types expect of an `err` serializer, as pino's has. */
type ErrorSerializer = (value: unknown) => {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
};

/** Serializers every application logger applies, whatever else it is given. */
export const LOG_SERIALIZERS = {
  err: serializeError as ErrorSerializer,
  error: serializeError as ErrorSerializer,
};

type LogMethodHook = NonNullable<
  NonNullable<LoggerOptions['hooks']>['logMethod']
>;

/**
 * Rewrites a log call's arguments before pino sees them.
 *
 * An error passed bare becomes `{ err }`, as pino would make it, but with
 * `logMessageOf` as its message, so a database error's text never becomes
 * `msg`. So does `{ err }` with no message. A message that quotes a top-level
 * database error's own text has it replaced (see `guardMessage`). Any other
 * top-level error, array or plain object, which no serializer would reach, is
 * serialized here, so an error nested inside one is scrubbed too.
 */
export function scrubLogArguments(args: unknown[]): unknown[] {
  const [first, ...rest] = args;

  if (first instanceof Error || isDatabaseError(first)) {
    const [msg, ...params] = rest;
    return [
      { err: first },
      msg === undefined ? logMessageOf(first) : guardMessage(msg, [first]),
      ...params,
    ];
  }

  if (!isPlainObject(first)) return args;

  let merged: Record<string, unknown> = first;
  for (const key of Object.keys(first)) {
    if (key === 'err' || key === 'error') continue;
    const value = first[key];
    if (!isErrorLike(value) && !Array.isArray(value) && !isPlainObject(value)) {
      continue;
    }
    if (merged === first) merged = { ...first };
    merged[key] = serializeError(first[key]);
  }

  const [msg, ...params] = rest;
  // pino takes `err.message` as `msg` when the call gives none.
  if (msg === undefined && first.msg === undefined && isErrorLike(first.err)) {
    return [merged, logMessageOf(first.err), ...params];
  }
  const guarded = guardMessage(msg, Object.values(first));
  return merged === first && guarded === msg
    ? args
    : [merged, guarded, ...params];
}

/**
 * A string message that is exactly a database error's own text becomes
 * `Database error <code>`; one that quotes it, such as `insert failed:
 * ${err.message}`, has every occurrence replaced with `[Redacted]`. Checked
 * against each database error among `values`, the call's top-level values.
 */
function guardMessage(msg: unknown, values: readonly unknown[]): unknown {
  if (typeof msg !== 'string') return msg;
  let guarded = msg;
  for (const value of values) {
    if (!isDatabaseError(value) || typeof value.message !== 'string') continue;
    if (value.message === '') continue;
    if (guarded === value.message) return logMessageOf(value);
    guarded = guarded.replaceAll(value.message, REDACTED);
  }
  return guarded;
}

const scrubLogMethod: LogMethodHook = function (args, method) {
  method.apply(this, scrubLogArguments(args) as Parameters<typeof method>);
};

/**
 * The scrub as a `logMethod` hook, run last: a caller's own hook sees the
 * arguments first, and whatever it hands on is scrubbed.
 */
export function scrubbingLogMethod(own?: LogMethodHook): LogMethodHook {
  if (!own) return scrubLogMethod;
  return function (args, method, level) {
    const scrubbed = function (this: Logger, ...inner: unknown[]) {
      scrubLogMethod.call(
        this,
        inner as Parameters<typeof method>,
        method,
        level,
      );
    } as typeof method;
    own.call(this, args, scrubbed, level);
  };
}

/** Options for a logger built outside Fastify: SQL debug, the seed, a bus. */
export function scrubbedLoggerOptions(level: string) {
  return {
    level,
    redact: LOG_REDACT_PATHS,
    serializers: { ...LOG_SERIALIZERS },
    hooks: { logMethod: scrubLogMethod },
  } satisfies LoggerOptions;
}

/**
 * The Fastify `logger` option: the default, or the caller's object merged over
 * it. The caller's own `redact` (an array, or `{ paths, ... }`) is kept and
 * joined with `LOG_REDACT_PATHS`. The caller's serializers are kept except
 * `err` and `error`, which are always the scrub, and the caller's `logMethod`
 * hook runs before the scrub's. `false` stays `false`.
 */
export function appLoggerOptions(
  override: FastifyServerOptions['logger'],
  level: string,
): FastifyServerOptions['logger'] {
  if (override === false) return false;
  if (override === undefined || override === true) {
    return scrubbedLoggerOptions(level);
  }
  const options = override as LoggerOptions & {
    redact?: string[] | { paths?: string[] };
  };
  const own = options.redact;
  const ownPaths = Array.isArray(own) ? own : (own?.paths ?? []);
  const rest = Array.isArray(own) || own === undefined ? {} : own;
  return {
    level,
    ...override,
    redact: {
      ...rest,
      paths: [...new Set([...LOG_REDACT_PATHS, ...ownPaths])],
    },
    serializers: { ...options.serializers, ...LOG_SERIALIZERS },
    hooks: {
      ...options.hooks,
      logMethod: scrubbingLogMethod(options.hooks?.logMethod),
    },
  };
}
