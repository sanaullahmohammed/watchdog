import type { FastifyServerOptions } from 'fastify';
import type { Logger } from 'pino';

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

/**
 * The Fastify `logger` option: the default, or the caller's object merged over
 * it. The caller's own `redact` (an array, or `{ paths, ... }`) is kept and
 * joined with `LOG_REDACT_PATHS`. `false` stays `false`.
 */
export function appLoggerOptions(
  override: FastifyServerOptions['logger'],
  level: string,
): FastifyServerOptions['logger'] {
  if (override === false) return false;
  if (override === undefined || override === true) {
    return { level, redact: LOG_REDACT_PATHS };
  }
  const own = (override as { redact?: string[] | { paths?: string[] } }).redact;
  const ownPaths = Array.isArray(own) ? own : (own?.paths ?? []);
  const rest = Array.isArray(own) || own === undefined ? {} : own;
  return {
    level,
    ...override,
    redact: {
      ...rest,
      paths: [...new Set([...LOG_REDACT_PATHS, ...ownPaths])],
    },
  };
}
