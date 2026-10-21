import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import confirmationSendsService from './confirmation-sends.service';

function setup() {
  const calls: { level: string; args: unknown[] }[] = [];
  const logger = new Proxy(
    {},
    {
      get:
        (_t, level: string) =>
        (...args: unknown[]) => {
          calls.push({ level, args });
        },
    },
  );
  const service = confirmationSendsService({
    logger,
  } as unknown as Dependencies);
  return { service, calls };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('confirmationSendsService', () => {
  it('drain waits for a tracked send, including one tracked while it waits', async () => {
    const { service } = setup();
    const first = deferred();
    service.track(first.promise);
    let drained = false;
    const draining = service.drain().then(() => {
      drained = true;
    });
    await tick();
    assert.equal(drained, false);

    const second = deferred();
    service.track(second.promise);
    first.resolve();
    await tick();
    assert.equal(drained, false);

    second.resolve();
    await draining;
    assert.equal(drained, true);
  });

  it('logs a rejection once at error without its message, and drain resolves', async () => {
    const { service, calls } = setup();
    const address = 'ann@x.test';
    const send = deferred();
    service.track(send.promise);
    send.reject(new Error(`cannot reach ${address}`));
    await service.drain();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, 'error');
    assert.ok(!JSON.stringify(calls[0].args).includes(address));
    assert.ok(!JSON.stringify(calls[0].args).includes('cannot reach'));
  });
});
