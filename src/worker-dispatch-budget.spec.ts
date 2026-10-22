import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dispatchBudgetMs } from '@/worker-dispatch-budget';

describe('story 6.7: the dispatch budget', () => {
  it('is the interval when the health limit leaves room for it', () => {
    assert.equal(dispatchBudgetMs(30_000, 120_000), 30_000);
  });

  it('is what the limit leaves after an interval and a send', () => {
    assert.equal(dispatchBudgetMs(60_000, 120_000), 5_000);
  });

  it('is never negative', () => {
    assert.equal(dispatchBudgetMs(90_000, 120_000), 0);
    assert.equal(dispatchBudgetMs(30_000, 60_000), 0);
  });
});
