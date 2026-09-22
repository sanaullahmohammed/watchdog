import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyErrorCodes, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { logFailure } from '@/server/error-logging';
import {
  type ApiErrorResponse,
  apiErrorResponseSchema,
} from '@/shared/api/api-error.response';
import { getRequestId } from '@/shared/app/app-request-context';
import { ExceptionBase } from '@/shared/exceptions';

const fastifyErrorCodesMap = {
  FST_ERR_VALIDATION: (error: FastifyError) => ({
    subErrors: (error.validation ?? []).map((validationError) => ({
      path: validationError.instancePath,
      message: validationError.message ?? '',
    })),
    statusCode: 400,
    message: 'Validation error',
    error: 'Bad Request', // https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.1
  }),
  FST_ERR_NOT_FOUND: () => ({
    message: 'Not Found',
    error: 'Not Found',
    statusCode: 404, //  'https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.4',
  }),
};

async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError | Error, request, res) => {
    // Handle fastify errors
    const fastifyError =
      'code' in error
        ? fastifyErrorCodesMap[error.code as keyof FastifyErrorCodes]
        : undefined;

    if (fastifyError) {
      const response = fastifyError(error);
      response.correlationId = getRequestId();
      return res.status(response.statusCode).send(response);
    }

    const correlationId = getRequestId();

    if (error instanceof ExceptionBase) {
      logFailure(request.log, error, error.statusCode, correlationId);
      return res.status(error.statusCode).send({
        statusCode: error.statusCode,
        message: error.message,
        error: error.error,
        correlationId,
      } satisfies ApiErrorResponse);
    }

    // Fastify refusing the request itself before any handler ran: a body that
    // is not the JSON its content type claims, one too large, a media type
    // with no parser. The status is the caller's and the message describes
    // their request, so both go back as they are. These once fell through to
    // the 500 below, logged at error: any anonymous POST with a broken body
    // wrote a level-50 line (Epic 3 retrospective, R-7).
    if (isRequestRefusal(error)) {
      logFailure(request.log, error, error.statusCode, correlationId);
      return res.status(error.statusCode).send({
        statusCode: error.statusCode,
        message: error.message,
        error: STATUS_CODES[error.statusCode] ?? 'Bad Request',
        correlationId,
      } satisfies ApiErrorResponse);
    }

    logFailure(request.log, error, 500, correlationId);
    return res.status(500).send({
      statusCode: 500,
      message: 'Internal Server Error', // https://datatracker.ietf.org/doc/html/rfc7231#section-6.6.1
      error: 'Internal Server Error',
      correlationId,
    } satisfies ApiErrorResponse);
  });

  // Add the ExceptionResponse schema to the fastify instance
  fastify.addSchema(apiErrorResponseSchema);
}

/** A Fastify error with a 4xx status, raised before any route handler ran. */
function isRequestRefusal(
  error: FastifyError | Error,
): error is FastifyError & { statusCode: number } {
  const { code, statusCode } = error as Partial<FastifyError>;
  return (
    typeof code === 'string' &&
    code.startsWith('FST_ERR_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  );
}

// Export the plugin
export default fp(errorHandlerPlugin, {
  name: 'errorHandler',
});
