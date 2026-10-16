import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLimiter, LimiterClosedError } from './check-limiter';

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
      limiter.run('a', async () => {
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
      limiter.run('a', async () => {
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
      limiter.run('a', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await limiter.run('a', async () => 'ok'), 'ok');
  });

  it('admits waiting organizations round-robin and still holds the cap', async () => {
    const limiter = createLimiter(() => 1);
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const gates = new Map<string, ReturnType<typeof gate>>();
    const submit = (key: string, name: string) => {
      const g = gate();
      gates.set(name, g);
      return limiter.run(key, async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(name);
        await g.promise;
        running -= 1;
      });
    };
    const done = [
      ...[1, 2, 3, 4, 5].map((n) => submit('A', `A${n}`)),
      submit('B', 'B1'),
    ];
    await tick();
    assert.deepEqual(order, ['A1']);
    for (const name of ['A1', 'B1', 'A2', 'A3', 'A4', 'A5']) {
      gates.get(name)?.open();
      await tick();
    }
    await Promise.all(done);
    assert.deepEqual(order, ['A1', 'B1', 'A2', 'A3', 'A4', 'A5']);
    assert.equal(peak, 1);
  });

  it('rotates through every waiting organization, not only the first two', async () => {
    const limiter = createLimiter(() => 1);
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const submit = (key: string, name: string) => {
      const g = gate();
      gates.set(name, g);
      return limiter.run(key, async () => {
        order.push(name);
        await g.promise;
      });
    };
    const done = [
      submit('A', 'A1'),
      submit('A', 'A2'),
      submit('A', 'A3'),
      submit('B', 'B1'),
      submit('B', 'B2'),
      submit('C', 'C1'),
      submit('C', 'C2'),
    ];
    const expected = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3'];
    for (const name of expected) {
      await tick();
      gates.get(name)?.open();
    }
    await Promise.all(done);
    assert.deepEqual(order, expected);
  });

  it('drops waiting tasks on close, lets running ones finish, and refuses later ones', async () => {
    const limiter = createLimiter(() => 1);
    const g = gate();
    const started: string[] = [];
    const first = limiter.run('a', async () => {
      started.push('first');
      await g.promise;
      return 'done';
    });
    const queued = limiter.run('b', async () => {
      started.push('queued');
    });
    const queuedOutcome = queued.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await tick();
    limiter.close();
    assert.ok((await queuedOutcome) instanceof LimiterClosedError);
    await assert.rejects(
      limiter.run('c', async () => 'late'),
      LimiterClosedError,
    );
    g.open();
    assert.equal(await first, 'done');
    assert.deepEqual(started, ['first']);
    assert.equal(limiter.active, 0);
  });
});
