import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLimiter } from './check-limiter';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('check limiter', () => {
  it('never admits more than the cap and admits again as slots free', async () => {
    const limiter = createLimiter(() => 2);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, gate);
    const done = gates.map((g) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
      }),
    );
    await tick();
    assert.equal(running, 2);
    gates[0].open();
    await tick();
    assert.equal(running, 2);
    for (const g of gates) g.open();
    await Promise.all(done);
    assert.equal(peak, 2);
    assert.equal(limiter.active, 0);
  });

  it('reads a lowered cap when it admits', async () => {
    let cap = 3;
    const limiter = createLimiter(() => cap);
    let running = 0;
    const gates = Array.from({ length: 6 }, gate);
    const done = gates.map((g) =>
      limiter.run(async () => {
        running += 1;
        await g.promise;
        running -= 1;
      }),
    );
    await tick();
    assert.equal(running, 3);
    cap = 1;
    gates[0].open();
    gates[1].open();
    await tick();
    // One left running; nothing new is admitted while active is at the cap.
    assert.equal(running, 1);
    for (const g of gates) g.open();
    await Promise.all(done);
  });

  it('frees the slot when a task rejects', async () => {
    const limiter = createLimiter(() => 1);
    await assert.rejects(
      limiter.run(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await limiter.run(async () => 'ok'), 'ok');
  });
});
