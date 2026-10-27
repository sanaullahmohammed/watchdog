import { type ExecutionResult, GraphQLError } from 'graphql';
import mercurius, { ErrorWithProps, type MercuriusContext } from 'mercurius';
import { logFailure } from '@/server/error-logging';
import { getRequestId } from '@/shared/app/app-request-context';
import {
  ExceptionBase,
  InternalServerErrorException,
} from '@/shared/exceptions';

/**
 * What a GraphQL caller is told when something fails, on the terms the REST
 * error handler already applies.
 *
 * An `ExceptionBase` is the application speaking, and its message passes
 * through. So does mercurius's `ErrorWithProps`, the type a resolver throws
 * to address the caller in GraphQL's own terms, as every authenticated
 * resolver's `UNAUTHENTICATED` refusal does. So does an error with no
 * `originalError`, which is GraphQL's own: a syntax, validation or
 * variable-coercion error describing the caller's query. So does mercurius's
 * validation wrapper, which is itself the `originalError`. It is recognised by
 * its code and by every member being a `GraphQLError` or Fastify's own
 * request-validation error, never by carrying a list: a native
 * `AggregateError` has one too, and names internal addresses. The wrapper for
 * a mutation sent by `GET` passes as well, on its code and its one fixed
 * message.
 * Anything else a resolver threw is an internal fault, such as a Postgres
 * message or a connection failure naming the database host, and the caller
 * sees only "Internal Server Error" and the correlation id. The original is
 * logged under that id, and every error is logged by who caused it, through
 * the policy REST uses (`src/server/error-logging.ts`). mercurius's own
 * formatter then builds the response, and a single masked error answers 500,
 * as REST does. Before this, resolver errors
 * reached callers verbatim (Epic 3 retrospective, R-6).
 *
 * Not a Fastify plugin, so it lives outside `src/server/plugins`, which
 * autoload evaluates at boot.
 */
export function graphqlErrorFormatter(
  execution: ExecutionResult & Required<Pick<ExecutionResult, 'errors'>>,
  context: MercuriusContext,
) {
  const log = context.reply?.log ?? context.app.log;
  const correlationId = getRequestId();

  const errors = execution.errors.map((error) => {
    const original = error.originalError;
    if (
      !original ||
      original instanceof ExceptionBase ||
      original instanceof ErrorWithProps ||
      isValidation(original)
    ) {
      logFailure(log, original ?? error, statusOf(original), correlationId);
      return error;
    }

    logFailure(log, original, 500, correlationId);
    return new GraphQLError(InternalServerErrorException.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: new InternalServerErrorException(),
      extensions: { correlationId },
    });
  });

  // The default formatter builds the response, and would also log every
  // error at info with its stack. Each is logged above by who caused it, so
  // it is handed a silent logger.
  const quiet = {
    ...context,
    reply: { log: log.child({}, { level: 'silent' }) },
  } as unknown as MercuriusContext;
  return mercurius.defaultErrorFormatter({ ...execution, errors }, quiet);
}

/**
 * The status a passed-through error stands for, for logging. An error with no
 * original is GraphQL's own verdict on the query, a caller's mistake. The
 * resolvers' `UNAUTHENTICATED` refusal stands for a 401, though GraphQL
 * answers it with a 200, and any other `ErrorWithProps` counts by the status
 * it carries once that status blames the caller.
 */
function statusOf(original: Error | undefined): number {
  if (original instanceof ExceptionBase) {
    return original.statusCode;
  }
  if (original instanceof ErrorWithProps) {
    const { code } = (original.extensions ?? {}) as { code?: unknown };
    if (code === 'UNAUTHENTICATED') {
      return 401;
    }
    // mercurius defaults its status to 200, which says nothing about blame.
    const status = original.statusCode ?? 200;
    return status >= 400 ? status : 400;
  }
  const { statusCode } = (original ?? {}) as { statusCode?: unknown };
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : 400;
}

/**
 * mercurius's own wrappers, by what they are. `MER_ERR_GQL_VALIDATION` carries
 * the query's errors, each a `GraphQLError`, or Fastify's own request
 * validation error (`FST_ERR_VALIDATION`); mercurius does not export the
 * class, so its code is its only identity, and the members check refuses any
 * other error that copies the code. `MER_ERR_METHOD_NOT_ALLOWED` carries one
 * fixed literal. Anything else with an `errors` list, such as an
 * `AggregateError`, is an internal fault. mercurius's `queryDepth`, which is
 * not configured here, would wrap `MER_ERR_GQL_QUERY_DEPTH` members, which
 * this check masks, so enabling it means revisiting the check.
 */
function isValidation(error: Error): boolean {
  const { code, errors } = error as { code?: unknown; errors?: unknown };
  if (code === 'MER_ERR_METHOD_NOT_ALLOWED') {
    return (
      Array.isArray(errors) &&
      errors.length === 1 &&
      (errors[0] as { message?: unknown } | undefined)?.message ===
        'Operation cannot be performed via a GET request'
    );
  }
  return (
    code === 'MER_ERR_GQL_VALIDATION' &&
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every(
      (member) => member instanceof GraphQLError || isRequestValidation(member),
    )
  );
}

/**
 * Fastify's own refusal of a malformed request, such as a POST with no body.
 * mercurius wraps it in `MER_ERR_GQL_VALIDATION`, and its message describes
 * the request's shape, so it is a 4xx the caller may read.
 */
function isRequestValidation(member: unknown): boolean {
  const { code, validation } = (member ?? {}) as {
    code?: unknown;
    validation?: unknown;
  };
  return code === 'FST_ERR_VALIDATION' && Array.isArray(validation);
}
