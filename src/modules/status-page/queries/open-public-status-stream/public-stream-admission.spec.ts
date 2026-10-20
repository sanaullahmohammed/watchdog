import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStreamAdmission } from './public-stream-admission';

/**
 * Story 4.5: the public stream's two caps, per client IP and per process.
 *
 * Needs no database; runs with the unit suite.
 */

const A = '10.0.0.1';
const B = '10.0.0.2';
const C = '10.0.0.3';

describe('Public stream admission', () => {
  it('admits up to the per-IP cap, and refuses the next from that IP only', () => {
    const admission = createStreamAdmission({ maxPerIp: 2, maxTotal: 100 });

    assert.ok(admission.admit(A));
    assert.ok(admission.admit(A));
    assert.equal(admission.admit(A), undefined);
    assert.ok(admission.admit(B), 'another IP has places of its own');
    assert.equal(admission.open(A), 2);
    assert.equal(admission.open(), 3);
  });

  it('admits up to the total cap across IPs, and refuses the next from any IP', () => {
    const admission = createStreamAdmission({ maxPerIp: 10, maxTotal: 3 });

    assert.ok(admission.admit(A));
    assert.ok(admission.admit(B));
    assert.ok(admission.admit(B));
    assert.equal(admission.admit(A), undefined);
    assert.equal(admission.admit(C), undefined, 'a new IP is refused too');
    assert.equal(admission.open(C), 0, 'a refusal holds no place');
    assert.equal(admission.open(), 3);
  });

  it('gives a place back on release, so the next opening is admitted at once', () => {
    const admission = createStreamAdmission({ maxPerIp: 1, maxTotal: 1 });

    const release = admission.admit(A);
    assert.ok(release);
    assert.equal(admission.admit(B), undefined);

    release();
    assert.equal(admission.open(), 0);
    assert.equal(admission.open(A), 0);
    assert.ok(admission.admit(B));
  });

  it('ignores a second release of the same place', () => {
    const admission = createStreamAdmission({ maxPerIp: 2, maxTotal: 2 });

    const first = admission.admit(A);
    const second = admission.admit(A);
    assert.ok(first && second);

    first();
    first();
    assert.equal(admission.open(A), 1, "the other stream's place is kept");
    assert.equal(admission.open(), 1);

    assert.ok(admission.admit(A));
    assert.equal(admission.admit(A), undefined, 'still capped at two');
  });

  it('keeps no entry for an IP once its last place is released', () => {
    const admission = createStreamAdmission({ maxPerIp: 1, maxTotal: 1 });

    const release = admission.admit(A);
    assert.ok(release);
    assert.equal(admission.trackedIps(), 1);
    release();
    release();

    assert.equal(admission.trackedIps(), 0);
    assert.equal(admission.open(), 0, 'never below zero');
    assert.ok(admission.admit(A));
    assert.equal(admission.admit(B), undefined);
  });
});
