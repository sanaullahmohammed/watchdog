import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Type } from 'typebox';
import { ArgumentInvalidException } from '@/shared/exceptions';
import {
  assertMatchesSchema,
  assertUuid,
} from '@/shared/validation/typebox-guard';

const schema = Type.Object({
  name: Type.String({ minLength: 1 }),
  order: Type.Optional(Type.Integer({ minimum: 0 })),
});

describe('assertMatchesSchema', () => {
  it('accepts a valid value, with or without optional fields', () => {
    assertMatchesSchema(schema, { name: 'a' });
    assertMatchesSchema(schema, { name: 'a', order: 0 });
  });

  it('names every failing field, without a leading slash', () => {
    assert.throws(
      () => assertMatchesSchema(schema, { name: '', order: -1 }),
      (error) => {
        assert.ok(error instanceof ArgumentInvalidException);
        assert.match(error.message, /(^|\s)name:/);
        assert.match(error.message, /(^|\s)order:/);
        assert.doesNotMatch(error.message, /\/name|\/order/);
        return true;
      },
    );
  });

  it('refuses a null for a field that is not nullable', () => {
    assert.throws(
      () => assertMatchesSchema(schema, { name: 'a', order: null }),
      /order/,
    );
  });
});

describe('assertMatchesSchema, message shapes', () => {
  const named = (message: string, field: string) =>
    message.split(field).length - 1;

  it('names a union-typed field once', () => {
    const union = Type.Object({
      group: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    });
    assert.throws(
      () => assertMatchesSchema(union, { group: 'nope' }),
      (error) => {
        assert.ok(error instanceof ArgumentInvalidException);
        assert.match(error.message, /^Invalid input\. /);
        assert.equal(named(error.message, 'group'), 1, error.message);
        return true;
      },
    );
  });

  it('names a missing required property', () => {
    assert.throws(
      () => assertMatchesSchema(schema, {}),
      (error) => error instanceof Error && /(^|\s)name:/.test(error.message),
    );
  });

  it('counts maxLength in code points, as REST does', () => {
    const name = Type.Object({ name: Type.String({ maxLength: 120 }) });
    assert.throws(
      () => assertMatchesSchema(name, { name: `a${'\u0301'.repeat(200)}` }),
      /name/,
    );
  });
});

describe('assertMatchesSchema, engine options', () => {
  it('compiles a date-time format and refuses a bad date', () => {
    const dated = Type.Object({ at: Type.String({ format: 'date-time' }) });
    assertMatchesSchema(dated, { at: '2026-10-06T10:00:00Z' });
    assert.throws(
      () => assertMatchesSchema(dated, { at: 'not-a-date' }),
      ArgumentInvalidException,
    );
  });

  it('does not coerce a string into an integer', () => {
    assert.throws(
      () => assertMatchesSchema(schema, { name: 'a', order: '1' }),
      ArgumentInvalidException,
    );
  });

  it('accepts an extra property and leaves it on the value', () => {
    const value = { name: 'a', extra: true };
    assertMatchesSchema(schema, value);
    assert.deepEqual(value, { name: 'a', extra: true });
  });

  it('names a nested missing property with its path', () => {
    const nested = Type.Object({
      a: Type.Array(Type.Object({ x: Type.String() })),
    });
    assert.throws(
      () => assertMatchesSchema(nested, { a: [{}] }),
      (error) => error instanceof Error && /a\/0\/x:/.test(error.message),
    );
  });
});

describe('assertUuid', () => {
  it('accepts a uuid', () => {
    assertUuid('2f1c1c5e-5a0e-4b1e-9d3a-0c9f6f1d2a11', 'id');
  });

  it('refuses anything else, naming the field', () => {
    for (const bad of ['not-a-uuid', '', null, 5]) {
      assert.throws(
        () => assertUuid(bad, 'id'),
        (error) =>
          error instanceof ArgumentInvalidException && /id/.test(error.message),
      );
    }
  });
});
