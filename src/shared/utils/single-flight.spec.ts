import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { singleFlight } from '@/shared/utils/single-flight';

/** A promise plus the handles to settle it from the test. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('does not start a second run while one is in flight', async () => {
    const gate = deferred();
    let starts = 0;
    const flight = singleFlight(() => {
      starts += 1;
      return gate.promise;
    });

    const first = flight.run();
    const second = flight.run();

    assert.equal(starts, 1);
    assert.equal(second, first, 'the caller gets the run already in flight');
    gate.resolve();
    await first;
  });

  it('exposes the run in flight so a shutdown can await it', async () => {
    const gate = deferred();
    const flight = singleFlight(() => gate.promise);

    assert.equal(flight.inFlight, null, 'idle');
    const run = flight.run();
    assert.equal(flight.inFlight, run);

    gate.resolve();
    await run;
    assert.equal(flight.inFlight, null, 'idle again once it settles');
  });

  it('starts a new run after the previous one settles', async () => {
    let starts = 0;
    const flight = singleFlight(async () => {
      starts += 1;
    });

    await flight.run();
    await flight.run();

    assert.equal(starts, 2);
  });

  it('does not wedge shut when a run fails', async () => {
    let starts = 0;
    const flight = singleFlight(async () => {
      starts += 1;
      throw new Error('pass failed');
    });

    await assert.rejects(flight.run());
    assert.equal(flight.inFlight, null);
    await assert.rejects(flight.run());

    assert.equal(starts, 2);
  });
});
