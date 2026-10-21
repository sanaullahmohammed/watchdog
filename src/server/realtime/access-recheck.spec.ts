import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RECHECK_LOOKUP_MAX_MS,
  recheckLookupDeadlineMs,
} from './access-recheck';

describe('recheckLookupDeadlineMs', () => {
  it('is the interval when the interval is below 10 s', () => {
    assert.equal(recheckLookupDeadlineMs(1_000), 1_000);
    assert.equal(recheckLookupDeadlineMs(9_999), 9_999);
  });

  it('is 10 s at 10 s', () => {
    assert.equal(RECHECK_LOOKUP_MAX_MS, 10_000);
    assert.equal(recheckLookupDeadlineMs(10_000), 10_000);
  });

  it('is capped at 10 s above it', () => {
    assert.equal(recheckLookupDeadlineMs(10_001), 10_000);
    assert.equal(recheckLookupDeadlineMs(60_000), 10_000);
    assert.equal(recheckLookupDeadlineMs(2_147_483_000), 10_000);
  });
});
