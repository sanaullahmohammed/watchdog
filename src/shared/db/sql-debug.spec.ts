import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pino from 'pino';
import {
  appLoggerOptions,
  LOG_REDACT_PATHS,
  sqlDebugOption,
} from '@/shared/db/sql-debug';

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
      assert.deepEqual(appLoggerOptions(override, 'warn'), {
        level: 'warn',
        redact: LOG_REDACT_PATHS,
      });
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
