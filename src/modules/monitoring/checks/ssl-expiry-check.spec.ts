import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { daysRemaining } from './ssl-expiry-check';

const HOUR = 3_600_000;
const now = new Date('2026-01-01T00:00:00Z');
const after = (ms: number) => new Date(now.getTime() + ms);

describe('daysRemaining', () => {
  it('floors to whole days', () => {
    assert.equal(daysRemaining(after(36 * HOUR), now), 1);
    assert.equal(daysRemaining(after(24 * HOUR), now), 1);
    assert.equal(daysRemaining(after(23 * HOUR), now), 0);
    assert.equal(daysRemaining(after(-1 * HOUR), now), -1);
  });
});
