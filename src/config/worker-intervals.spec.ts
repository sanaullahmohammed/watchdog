import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertWorkerIntervals } from './worker-intervals';

describe('worker interval cross-check', () => {
  it('throws naming both variables when overdue equals the maintenance interval', () => {
    assert.throws(
      () =>
        assertWorkerIntervals({
          WORKER_PASS_OVERDUE_MS: 5_000,
          WORKER_MAINTENANCE_INTERVAL_MS: 5_000,
          WORKER_MONITOR_INTERVAL_MS: 1_000,
        }),
      /WORKER_PASS_OVERDUE_MS \(5000\) must be greater than WORKER_MAINTENANCE_INTERVAL_MS \(5000\)/,
    );
  });

  it('throws naming both variables when overdue equals the monitor interval', () => {
    assert.throws(
      () =>
        assertWorkerIntervals({
          WORKER_PASS_OVERDUE_MS: 5_000,
          WORKER_MAINTENANCE_INTERVAL_MS: 1_000,
          WORKER_MONITOR_INTERVAL_MS: 5_000,
        }),
      /WORKER_PASS_OVERDUE_MS \(5000\) must be greater than WORKER_MONITOR_INTERVAL_MS \(5000\)/,
    );
  });

  it('passes when overdue is above both', () => {
    assert.doesNotThrow(() =>
      assertWorkerIntervals({
        WORKER_PASS_OVERDUE_MS: 5_001,
        WORKER_MAINTENANCE_INTERVAL_MS: 5_000,
        WORKER_MONITOR_INTERVAL_MS: 5_000,
      }),
    );
  });
});
