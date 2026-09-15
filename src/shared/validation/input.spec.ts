import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArgumentInvalidException } from '@/shared/exceptions';
import {
  assertNoDuplicates,
  assertNoNullFields,
  assertNotBlank,
  parseDate,
  parseOptionalDate,
} from '@/shared/validation/input';

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

describe('parseOptionalDate', () => {
  it('treats absent and null as not supplied', () => {
    assert.equal(parseOptionalDate(undefined, 'startedAt'), undefined);
    assert.equal(parseOptionalDate(null, 'startedAt'), undefined);
  });

  it('still refuses a supplied value that is not a date', () => {
    // An empty string is a mistake, not an absence.
    assert.throws(
      () => parseOptionalDate('', 'startedAt'),
      ArgumentInvalidException,
    );
  });
});

describe('assertNoNullFields', () => {
  it('accepts absent fields and fields that hold values', () => {
    assert.doesNotThrow(() =>
      assertNoNullFields({ title: 'x', displayOrder: 0, isPublic: false }),
    );
  });

  it('refuses an explicit null, naming every offender', () => {
    assert.throws(
      () => assertNoNullFields({ title: null, impact: null, id: 'x' }),
      { message: /title, impact cannot be null/ },
    );
  });

  it('allows null where the caller may genuinely mean it', () => {
    assert.doesNotThrow(() =>
      assertNoNullFields(
        { description: null, serviceGroupId: null, name: 'x' },
        { nullable: ['description', 'serviceGroupId'] },
      ),
    );
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

describe('assertNotBlank', () => {
  it('accepts text', () => {
    assert.doesNotThrow(() =>
      assertNotBlank('We are investigating', 'message'),
    );
  });

  it('refuses empty and whitespace-only text', () => {
    for (const value of ['', '   ', '\n\t']) {
      assert.throws(
        () => assertNotBlank(value, 'message'),
        ArgumentInvalidException,
      );
    }
  });
});
