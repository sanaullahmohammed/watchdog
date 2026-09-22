import { type ExecutionResult, GraphQLError } from 'graphql';
import mercurius, { ErrorWithProps, type MercuriusContext } from 'mercurius';
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
 * `originalError`, which is GraphQL's own:
 * a syntax, validation or variable-coercion error describing the caller's
 * query, and mercurius's validation wrapper, which carries a list of them.
 * Anything else a resolver threw is an internal fault, such as a Postgres
 * message or a connection failure naming the database host, and the caller
 * sees only "Internal Server Error" and the correlation id. The original is
 * logged under that id. mercurius's own formatter then takes over, and a
 * single masked error answers 500, as REST does. Before this, resolver errors
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

  const errors = execution.errors.map((error) => {
    const original = error.originalError;
    if (
      !original ||
      original instanceof ExceptionBase ||
      original instanceof ErrorWithProps ||
      isValidation(original)
    ) {
      return error;
    }

    const correlationId = getRequestId();
    log.error({ err: original, correlationId }, 'GraphQL resolver failed');
    return new GraphQLError(InternalServerErrorException.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: new InternalServerErrorException(),
      extensions: { correlationId },
    });
  });

  return mercurius.defaultErrorFormatter({ ...execution, errors }, context);
}

/** mercurius's `MER_ERR_GQL_VALIDATION`: the query's own validation errors. */
function isValidation(error: Error): boolean {
  return Array.isArray((error as { errors?: unknown }).errors);
}
