import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retryDelaySeconds } from './retry-delay';

describe('story 6.7: retryDelaySeconds', () => {
  it('pins the default schedule', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelaySeconds(n, 60, 3600)),
      [60, 120, 240, 480, 960, 1920, 3600],
    );
  });

  it('stays at the maximum however many attempts', () => {
    assert.equal(retryDelaySeconds(100, 60, 3600), 3600);
  });

  it('never goes below the base on the first attempt', () => {
    assert.equal(retryDelaySeconds(1, 300, 300), 300);
  });
});
