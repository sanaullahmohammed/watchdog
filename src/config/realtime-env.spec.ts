import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { realtimeEnvProperties } from './realtime-env';

const schema = Type.Object(realtimeEnvProperties);

describe('ADMIN_SUBSCRIPTION_RECHECK_SECONDS', () => {
  it('defaults to 60', () => {
    const value = Value.Default(schema, {}) as Record<string, unknown>;
    assert.equal(value.ADMIN_SUBSCRIPTION_RECHECK_SECONDS, 60);
  });

  it("accepts 1 and setTimeout's largest delay in seconds", () => {
    for (const ok of [1, 2_147_483]) {
      assert.equal(
        Value.Check(schema, { ADMIN_SUBSCRIPTION_RECHECK_SECONDS: ok }),
        true,
        String(ok),
      );
    }
  });

  it('refuses a value over 2147483', () => {
    assert.equal(
      Value.Check(schema, { ADMIN_SUBSCRIPTION_RECHECK_SECONDS: 2_147_484 }),
      false,
    );
  });

  it('refuses 0 and a fraction', () => {
    for (const bad of [0, 1.5]) {
      assert.equal(
        Value.Check(schema, { ADMIN_SUBSCRIPTION_RECHECK_SECONDS: bad }),
        false,
        String(bad),
      );
    }
  });
});
