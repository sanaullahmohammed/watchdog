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
});
