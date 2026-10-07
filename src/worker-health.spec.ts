import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessWorkerHealth } from './worker-health';

const NOW = Date.parse('2026-01-01T00:10:00.000Z');
const limits = { overdueMs: 120_000, maxAgeMs: 60_000 };
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function record(overrides: {
  bootedAgo?: number;
  writtenAgo?: number;
  completedAgo?: number | null;
}) {
  const completed =
    overrides.completedAgo === undefined ? 5_000 : overrides.completedAgo;
  return {
    bootedAt: ago(overrides.bootedAgo ?? 600_000),
    writtenAt: ago(overrides.writtenAgo ?? 1_000),
    loops: {
      maintenance: {
        lastStartedAt: ago(6_000),
        lastCompletedAt: completed === null ? null : ago(completed),
      },
    },
  };
}

describe('assessWorkerHealth', () => {
  it('is healthy when passes complete every interval', () => {
    assert.equal(assessWorkerHealth(record({}), NOW, limits).healthy, true);
  });

  it('is healthy for a slow pass under the threshold', () => {
    const result = assessWorkerHealth(
      record({ completedAgo: 90_000 }),
      NOW,
      limits,
    );
    assert.equal(result.healthy, true);
  });

  it('fails a stuck pass once the threshold has passed', () => {
    const result = assessWorkerHealth(
      record({ completedAgo: 121_000 }),
      NOW,
      limits,
    );
    assert.equal(result.healthy, false);
    assert.match(result.reason, /maintenance/);
  });

  it('is healthy just after boot with no completed pass', () => {
    const result = assessWorkerHealth(
      record({ bootedAgo: 30_000, completedAgo: null }),
      NOW,
      limits,
    );
    assert.equal(result.healthy, true);
  });

  it('fails when no pass ever completed and the threshold passed since boot', () => {
    const result = assessWorkerHealth(
      record({ bootedAgo: 130_000, completedAgo: null }),
      NOW,
      limits,
    );
    assert.equal(result.healthy, false);
  });

  it('fails when the record is older than the heartbeat limit', () => {
    const result = assessWorkerHealth(
      record({ writtenAgo: 61_000 }),
      NOW,
      limits,
    );
    assert.equal(result.healthy, false);
    assert.match(result.reason, /heartbeat/);
  });

  it('fails closed on a missing, malformed or loop-less record', () => {
    for (const bad of [
      null,
      undefined,
      'text',
      [],
      {},
      { bootedAt: ago(1), writtenAt: ago(1) },
      { bootedAt: ago(1), writtenAt: ago(1), loops: {} },
    ]) {
      assert.equal(assessWorkerHealth(bad, NOW, limits).healthy, false);
    }
  });

  it('is healthy at exactly the threshold and fails one millisecond past it', () => {
    assert.equal(
      assessWorkerHealth(record({ completedAgo: 120_000 }), NOW, limits)
        .healthy,
      true,
    );
    assert.equal(
      assessWorkerHealth(record({ completedAgo: 120_001 }), NOW, limits)
        .healthy,
      false,
    );
  });

  it('fails on a timestamp that is not a date', () => {
    for (const field of ['bootedAt', 'writtenAt'] as const) {
      const bad = { ...record({}), [field]: 'not a date' };
      assert.equal(assessWorkerHealth(bad, NOW, limits).healthy, false);
    }
    const badLoop = record({});
    badLoop.loops.maintenance.lastCompletedAt = 'nope';
    assert.equal(assessWorkerHealth(badLoop, NOW, limits).healthy, false);
  });

  it('counts a writtenAt in the future as age 0', () => {
    const result = assessWorkerHealth(
      record({ writtenAgo: -5_000 }),
      NOW,
      limits,
    );
    assert.equal(result.healthy, true);
  });

  it('fails when any one loop is overdue', () => {
    const base = record({});
    const result = assessWorkerHealth(
      {
        ...base,
        loops: {
          ...base.loops,
          monitor: { lastStartedAt: null, lastCompletedAt: ago(200_000) },
        },
      },
      NOW,
      limits,
    );
    assert.equal(result.healthy, false);
    assert.match(result.reason, /monitor/);
  });

  it('fails closed on a malformed loop entry', () => {
    for (const entry of [42, {}, null]) {
      const result = assessWorkerHealth(
        { ...record({}), loops: { maintenance: entry } },
        NOW,
        limits,
      );
      assert.equal(result.healthy, false);
      assert.match(result.reason, /maintenance/);
    }
  });
});
