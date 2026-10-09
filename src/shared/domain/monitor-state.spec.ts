import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { monitorStateOf } from './monitor-state';

const CHECKED = new Date('2026-10-09T12:00:00Z');
const base = {
  enabled: true,
  lastCheckedAt: CHECKED,
  consecutiveFailures: 0,
  failureThreshold: 3,
};

describe('monitorStateOf (DOMAIN M1)', () => {
  it('is healthy at 0 failures', () => {
    assert.equal(monitorStateOf(base), 'healthy');
  });

  it('is degraded above 0 and below the threshold', () => {
    assert.equal(
      monitorStateOf({ ...base, consecutiveFailures: 1 }),
      'degraded',
    );
    assert.equal(
      monitorStateOf({ ...base, consecutiveFailures: 2 }),
      'degraded',
    );
  });

  it('is failing at the threshold and above it', () => {
    assert.equal(
      monitorStateOf({ ...base, consecutiveFailures: 3 }),
      'failing',
    );
    assert.equal(
      monitorStateOf({ ...base, consecutiveFailures: 9 }),
      'failing',
    );
  });

  it('is failing at 1 failure when the threshold is 1', () => {
    assert.equal(
      monitorStateOf({ ...base, failureThreshold: 1, consecutiveFailures: 1 }),
      'failing',
    );
  });

  it('is null when disabled, whatever the counters say', () => {
    for (const consecutiveFailures of [0, 1, 5]) {
      assert.equal(
        monitorStateOf({ ...base, enabled: false, consecutiveFailures }),
        null,
      );
    }
  });

  it('is null when never checked, whatever the counters say', () => {
    for (const consecutiveFailures of [0, 1, 5]) {
      assert.equal(
        monitorStateOf({ ...base, lastCheckedAt: null, consecutiveFailures }),
        null,
      );
    }
  });
});
