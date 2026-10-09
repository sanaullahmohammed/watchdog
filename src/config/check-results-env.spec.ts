import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { checkResultsEnvProperties } from './check-results-env';

const schema = Type.Object(checkResultsEnvProperties);

describe('CHECK_RESULTS_RETENTION_DAYS', () => {
  it('defaults to 30', () => {
    const value = Value.Default(schema, {}) as Record<string, unknown>;
    assert.equal(value.CHECK_RESULTS_RETENTION_DAYS, 30);
  });

  it('accepts a positive whole number', () => {
    assert.equal(
      Value.Check(schema, { CHECK_RESULTS_RETENTION_DAYS: 1 }),
      true,
    );
  });

  it('refuses a value over 36500', () => {
    assert.equal(
      Value.Check(schema, { CHECK_RESULTS_RETENTION_DAYS: 36_500 }),
      true,
    );
    assert.equal(
      Value.Check(schema, { CHECK_RESULTS_RETENTION_DAYS: 36_501 }),
      false,
    );
  });

  it('refuses 0 and a fraction', () => {
    assert.equal(
      Value.Check(schema, { CHECK_RESULTS_RETENTION_DAYS: 0 }),
      false,
    );
    assert.equal(
      Value.Check(schema, { CHECK_RESULTS_RETENTION_DAYS: 1.5 }),
      false,
    );
  });
});
