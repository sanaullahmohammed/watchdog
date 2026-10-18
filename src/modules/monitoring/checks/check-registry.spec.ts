import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCheckRegistry } from './check-registry';

function gate() {
  let open: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

describe('check registry', () => {
  it('runs one task per id and returns null for a registered id', async () => {
    const registry = createCheckRegistry();
    const g = gate();
    let runs = 0;
    const first = registry.start('a', async () => {
      runs += 1;
      await g.promise;
      return 'done';
    });
    assert.ok(first);
    assert.equal(registry.has('a'), true);
    assert.equal(
      registry.start('a', async () => {
        runs += 1;
      }),
      null,
    );
    g.open();
    assert.equal(await first, 'done');
    assert.equal(runs, 1);
    assert.equal(registry.has('a'), false);
    assert.ok(registry.start('a', async () => {}));
  });

  it('releases on success, failure and a synchronous throw', async () => {
    const registry = createCheckRegistry();
    await registry.start('ok', async () => 1);
    assert.equal(registry.size, 0);
    await assert.rejects(
      registry.start('bad', async () => {
        throw new Error('boom');
      }) as Promise<unknown>,
      /boom/,
    );
    assert.equal(registry.size, 0);
    await assert.rejects(
      registry.start('sync', () => {
        throw new Error('sync boom');
      }) as Promise<unknown>,
      /sync boom/,
    );
    assert.equal(registry.size, 0);
    assert.equal(registry.has('sync'), false);
  });

  it('drain waits until the registry is empty, whatever the outcomes', async () => {
    const registry = createCheckRegistry();
    const a = gate();
    const b = gate();
    registry.start('a', () => a.promise)?.catch(() => undefined);
    registry.start('b', () => b.promise)?.catch(() => undefined);
    let drained = false;
    const draining = registry.drain().then(() => {
      drained = true;
    });
    a.fail(new Error('x'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    b.open();
    await draining;
    assert.equal(registry.size, 0);
    await registry.drain();
  });

  it('is stalled only when non-empty and nothing settled for the window', async () => {
    let now = 1_000;
    const registry = createCheckRegistry(() => now);
    assert.equal(registry.stalled(100), false);
    const a = gate();
    const b = gate();
    const pa = registry.start('a', () => a.promise);
    registry.start('b', () => b.promise)?.catch(() => undefined);
    now += 99;
    assert.equal(registry.stalled(100), false);
    now += 1;
    assert.equal(registry.stalled(100), true);
    // A settle resets the clock even though the registry is still non-empty.
    a.open();
    await pa;
    assert.equal(registry.stalled(100), false);
    now += 100;
    assert.equal(registry.stalled(100), true);
    b.open();
    await registry.drain();
    now += 10_000;
    assert.equal(registry.stalled(100), false);
    // Empty to non-empty restarts the clock.
    const c = gate();
    registry.start('c', () => c.promise);
    assert.equal(registry.stalled(100), false);
    c.open();
    await registry.drain();
  });

  it('does not reset the clock when a start finds the registry non-empty', async () => {
    let now = 0;
    const registry = createCheckRegistry(() => now);
    const a = gate();
    registry.start('a', () => a.promise)?.catch(() => undefined);
    now += 100;
    registry.start('b', () => new Promise(() => {}));
    assert.equal(registry.stalled(100), true);
  });

  it('counts a rejected task as unsettled, even after the registry empties', async () => {
    let now = 0;
    const registry = createCheckRegistry(() => now);
    const fail = async () => {
      throw new Error('record failed');
    };
    await assert.rejects(registry.start('a', fail) as Promise<unknown>);
    assert.equal(registry.size, 0);
    assert.equal(registry.stalled(100), false);
    now += 60;
    // Empty to non-empty with a failure pending: the clock keeps running.
    await assert.rejects(registry.start('a', fail) as Promise<unknown>);
    now += 60;
    assert.equal(registry.stalled(100), true);
    // A tick that finds nothing due clears it.
    registry.idle();
    assert.equal(registry.stalled(100), false);
  });

  it('clears a pending failure when a later task settles', async () => {
    let now = 0;
    const registry = createCheckRegistry(() => now);
    await assert.rejects(
      registry.start('a', async () => {
        throw new Error('x');
      }) as Promise<unknown>,
    );
    now += 500;
    assert.equal(registry.stalled(100), true);
    await registry.start('b', async () => 'skipped');
    assert.equal(registry.stalled(100), false);
  });

  it('forgets everything on reset', () => {
    const registry = createCheckRegistry(() => 0);
    registry.start('a', () => new Promise(() => {}));
    registry.reset();
    assert.equal(registry.size, 0);
    assert.ok(registry.start('a', async () => {}));
  });

  it('does not release a newer task registered under the same id after reset', async () => {
    const registry = createCheckRegistry(() => 0);
    const old = gate();
    const oldRun = registry.start('a', () => old.promise);
    registry.reset();
    registry.start('a', () => new Promise(() => {}));
    old.open();
    await oldRun;
    assert.equal(registry.has('a'), true);
  });
});
