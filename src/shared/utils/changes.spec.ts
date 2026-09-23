import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anyChanged, sameSet } from '@/shared/utils/changes';

/** Epic 2's D-3, decided 2026-09-23: an edit announces a change, not an attempt. */

describe('anyChanged', () => {
  it('sees a changed value, and ignores a key it was not asked about', () => {
    const before = { title: 'Before', impact: 'minor' };
    assert.equal(
      anyChanged(before, { ...before, title: 'After' }, ['title']),
      true,
    );
    assert.equal(
      anyChanged(before, { ...before, title: 'After' }, ['impact']),
      false,
    );
  });

  it('compares dates by their instant, not by identity', () => {
    const at = new Date('2026-09-23T10:00:00.000Z');
    const before = { startedAt: at };
    assert.equal(
      anyChanged(before, { startedAt: new Date(at) }, ['startedAt']),
      false,
    );
    assert.equal(
      anyChanged(before, { startedAt: new Date(at.valueOf() + 1000) }, [
        'startedAt',
      ]),
      true,
    );
  });

  it('treats null and undefined as different from a value, and from each other', () => {
    assert.equal(anyChanged({ note: null }, { note: 'x' }, ['note']), true);
    assert.equal(anyChanged({ note: null }, { note: null }, ['note']), false);
  });
});

describe('sameSet', () => {
  it('ignores order', () => {
    assert.equal(sameSet(['a', 'b'], ['b', 'a']), true);
  });

  it('sees an addition, a removal and a substitution', () => {
    assert.equal(sameSet(['a'], ['a', 'b']), false);
    assert.equal(sameSet(['a', 'b'], ['a']), false);
    assert.equal(sameSet(['a'], ['b']), false);
  });

  it('holds for empty collections', () => {
    assert.equal(sameSet([], []), true);
    assert.equal(sameSet([], ['a']), false);
  });
});
