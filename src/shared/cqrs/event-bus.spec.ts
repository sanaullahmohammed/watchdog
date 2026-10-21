import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pino from 'pino';
import postgres from 'postgres';
import { eventBus, reportToLogger } from '@/shared/cqrs/event-bus';
import { scrubbedLoggerOptions } from '@/shared/db/sql-debug';
import { captureLogs } from '@/shared/testing/logs';

const ADDRESS = 'subscriber-in-a-handler@example.test';

/** A unique violation as postgres.js reports it, quoting the address. */
function uniqueViolation() {
  return new postgres.PostgresError({
    message: 'duplicate key value violates unique constraint "s_email_key"',
    severity: 'ERROR',
    code: '23505',
    detail: `Key (email)=(${ADDRESS}) already exists.`,
    constraint_name: 's_email_key',
  } as never);
}

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

  it('drains async handlers that are still running', async () => {
    const bus = eventBus();
    const finished: string[] = [];

    bus.on('service.created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished.push('slow');
    });
    bus.emit({ type: 'service.created', payload: {} });

    assert.deepEqual(finished, [], 'emit does not await the handler');
    await bus.drain();
    assert.deepEqual(finished, ['slow'], 'drain does');
  });

  it('drains a handler that fails, and is a no-op when nothing is running', async () => {
    const failures: unknown[] = [];
    const bus = eventBus({ onHandlerError: (error) => failures.push(error) });

    await bus.drain();

    bus.on('service.created', async () => {
      throw new Error('async boom');
    });
    bus.emit({ type: 'service.created', payload: {} });
    await bus.drain();

    assert.equal(failures.length, 1, 'a failed handler still settles');
    await bus.drain();
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

  // Story 6.1: a failure is reported through a scrubbing logger, never
  // printed with console.error, which shows a database error's every field.

  it('reports through a logger whose serializer scrubs a database error', () => {
    const logs = captureLogs();
    const bus = eventBus({
      onHandlerError: reportToLogger(
        pino(scrubbedLoggerOptions('info'), logs.stream),
      ),
    });
    bus.on('service.created', () => {
      throw uniqueViolation();
    });

    bus.emit({ type: 'service.created', payload: {} });

    assert.equal(logs.lines.length, 1);
    assert.ok(!logs.lines[0]?.includes(ADDRESS), logs.lines[0]);
    const [entry] = logs.entries();
    assert.equal(entry?.msg, 'Event handler for service.created failed');
    assert.equal(entry?.eventType, 'service.created');
    assert.equal(entry?.err?.code, '23505');
  });

  it('never calls console.error by default, and scrubs what it writes', (t) => {
    const consoleError = t.mock.method(console, 'error', () => {});
    const written: string[] = [];
    // The default reporter's logger writes to stderr; capture it, briefly and
    // synchronously, so the run stays quiet.
    const write = t.mock.method(
      process.stderr,
      'write',
      (chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      },
    );

    try {
      const bus = eventBus();
      bus.on('service.created', () => {
        throw uniqueViolation();
      });
      bus.emit({ type: 'service.created', payload: {} });
    } finally {
      write.mock.restore();
    }

    assert.equal(consoleError.mock.callCount(), 0);
    assert.equal(written.length, 1, 'the failure was reported');
    assert.ok(!written[0]?.includes(ADDRESS), written[0]);
    assert.equal(JSON.parse(written[0] ?? '').err.code, '23505');
  });
});
