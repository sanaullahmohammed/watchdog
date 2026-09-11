import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventBus } from '@/shared/cqrs/event-bus';

describe('eventBus', () => {
  it('delivers one event to every registered handler', () => {
    const bus = eventBus();
    const seen: string[] = [];

    // ARCHITECTURE.md 5.2: the NOTIFY bridge fans an event out to clients while
    // a module recomputes derived state from the same event. Both must run.
    bus.on('service.created', () => seen.push('bridge'));
    bus.on('service.created', () => seen.push('recompute'));

    bus.emit({ type: 'service.created', payload: { id: 'svc' } });

    assert.deepEqual(seen, ['bridge', 'recompute']);
  });

  it('treats an event with no subscriber as a no-op', () => {
    const bus = eventBus();

    // Domain events are fire-and-forget. Most of DOMAIN.md's catalog has no
    // in-process reaction; it exists to be bridged, or simply to be recorded.
    assert.doesNotThrow(() =>
      bus.emit({ type: 'incident.resolved', payload: {} }),
    );
  });

  it('does not let one event type reach another type handler', () => {
    const bus = eventBus();
    let called = 0;

    bus.on('service.created', () => {
      called += 1;
    });
    bus.emit({ type: 'service.updated', payload: {} });

    assert.equal(called, 0);
  });

  it('still rejects a malformed event', () => {
    const bus = eventBus();

    assert.throws(() => bus.emit(undefined as never), TypeError);
    assert.throws(() => bus.emit({ payload: {} } as never), TypeError);
  });

  // Epic 2 retrospective, R-4. Events are emitted after the emitting command
  // commits, so a handler's failure can only do harm by escaping: skipping the
  // handlers after it, failing a request whose change already happened, or
  // leaving a rejection unhandled.

  it('keeps delivering to later handlers when one throws, and does not throw itself', () => {
    const failures: string[] = [];
    const bus = eventBus({
      onHandlerError: (error, event) =>
        failures.push(`${event.type}: ${(error as Error).message}`),
    });
    const seen: string[] = [];

    bus.on('incident.resolved', () => {
      throw new Error('boom');
    });
    bus.on('incident.resolved', () => seen.push('after'));

    assert.doesNotThrow(() =>
      bus.emit({ type: 'incident.resolved', payload: {} }),
    );
    assert.deepEqual(seen, ['after']);
    assert.deepEqual(failures, ['incident.resolved: boom']);
  });

  it("catches an async handler's rejection instead of leaving it unhandled", async () => {
    const failures: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const bus = eventBus({ onHandlerError: (error) => failures.push(error) });
      bus.on('service.created', async () => {
        throw new Error('async boom');
      });

      bus.emit({ type: 'service.created', payload: {} });
      // Rejections are reported once the microtask queue drains.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.equal(failures.length, 1);
    assert.deepEqual(unhandled, []);
  });

  it('isolates handlers on the middleware path too', () => {
    const failures: unknown[] = [];
    const bus = eventBus({ onHandlerError: (error) => failures.push(error) });
    // The app always adds middleware (decorateWithMetadata), so this is the
    // path production takes.
    bus.addMiddleware((action, handler) => handler(action) as never);
    const seen: string[] = [];

    bus.on('service.created', () => {
      throw new Error('boom');
    });
    bus.on('service.created', () => seen.push('after'));

    assert.doesNotThrow(() =>
      bus.emit({ type: 'service.created', payload: {} }),
    );
    assert.deepEqual(seen, ['after']);
    assert.equal(failures.length, 1);
  });

  it('survives a reporter that throws', () => {
    const bus = eventBus({
      onHandlerError: () => {
        throw new Error('the logger is down');
      },
    });
    const seen: string[] = [];

    bus.on('service.created', () => {
      throw new Error('boom');
    });
    bus.on('service.created', () => seen.push('after'));

    assert.doesNotThrow(() =>
      bus.emit({ type: 'service.created', payload: {} }),
    );
    assert.deepEqual(seen, ['after']);
  });
});
