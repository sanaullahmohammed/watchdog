import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArgumentInvalidException } from '@/shared/exceptions';
import { assertNoDuplicates, parseDate } from '@/shared/validation/input';

describe('parseDate', () => {
  it('parses an ISO date-time', () => {
    assert.equal(
      parseDate('2026-09-15T02:00:00.000Z', 'scheduledStartAt').toISOString(),
      '2026-09-15T02:00:00.000Z',
    );
  });

  it('refuses what Date would call Invalid, naming the field', () => {
    for (const value of ['not-a-date', '', '2026-13-45T99:99:99Z']) {
      assert.throws(
        () => parseDate(value, 'scheduledStartAt'),
        (error: Error) =>
          error instanceof ArgumentInvalidException &&
          /scheduledStartAt/.test(error.message),
        `accepted ${JSON.stringify(value)}`,
      );
    }
  });
});

describe('assertNoDuplicates', () => {
  it('accepts a list with no repeats, including an empty one', () => {
    assert.doesNotThrow(() => assertNoDuplicates([], 'affectedServiceIds'));
    assert.doesNotThrow(() =>
      assertNoDuplicates(['a', 'b'], 'affectedServiceIds'),
    );
  });

  it('names each thing listed more than once, once', () => {
    assert.throws(
      () => assertNoDuplicates(['a', 'b', 'a', 'a'], 'affectedServiceIds'),
      { message: /affectedServiceIds names a more than once/ },
    );
  });
});
