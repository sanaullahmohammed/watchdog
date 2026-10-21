import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import postgres from 'postgres';
import { logFailure } from '@/server/error-logging';

/**
 * Story 6.1: the message `logFailure` hands its logger. Checked on the call
 * itself, not through pino, whose scrubbing hook would hide a regression here.
 */

const ADDRESS = 'subscriber-in-log-failure@example.test';

function recordingLog() {
  const calls: { level: string; args: unknown[] }[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push({ level, args });
    };
  const log = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
  } as unknown as FastifyBaseLogger;
  return { log, calls };
}

describe('logFailure (story 6.1)', () => {
  it('names a 5xx database error by its code, never by its message', () => {
    const { log, calls } = recordingLog();
    const error = new postgres.PostgresError({
      message: `invalid input syntax for type integer: "${ADDRESS}"`,
      severity: 'ERROR',
      code: '22P02',
    } as never);

    logFailure(log, error, 500, 'c-1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.level, 'error');
    assert.equal(calls[0]?.args[1], 'Database error 22P02');
    assert.deepEqual(calls[0]?.args[0], { err: error, correlationId: 'c-1' });
  });

  it('still names any other 5xx by its message', () => {
    const { log, calls } = recordingLog();
    logFailure(log, new Error('the database went away'), 500, 'c-2');
    assert.equal(calls[0]?.args[1], 'the database went away');
  });

  it("logs Fastify's own refusal of a request by its code", () => {
    const { log, calls } = recordingLog();
    const error = Object.assign(new Error(`quotes "${ADDRESS}"`), {
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      statusCode: 400,
    });

    logFailure(log, error, 400, 'c-3');

    assert.deepEqual(calls, [
      {
        level: 'info',
        args: [
          { statusCode: 400, correlationId: 'c-3' },
          'FST_ERR_CTP_INVALID_JSON_BODY',
        ],
      },
    ]);
  });

  it('keeps the message of any other 4xx', () => {
    const { log, calls } = recordingLog();
    logFailure(log, new Error('Authentication required'), 401, 'c-4');
    assert.equal(calls[0]?.level, 'warn');
    assert.equal(calls[0]?.args[1], 'Authentication required');
  });
});
