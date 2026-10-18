import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Sql } from 'postgres';
import type { Action } from '@/shared/cqrs/bus.types';
import { eventBus } from '@/shared/cqrs/event-bus';
import { incidentCreatedEvent } from '@/shared/events/incident.events';
import { monitorCreatedEvent } from '@/shared/events/monitor.events';
import { registerNotifyBridge } from '@/shared/realtime/notify-bridge';
import { NOTIFY_CHANNEL } from '@/shared/realtime/realtime-event';

/**
 * Story 4.3: a refused `pg_notify` is a handler failure like any other. The
 * command already committed, so the emitter is not told, and the handlers
 * after the bridge still run.
 *
 * Needs no database: the `sql` here is a tagged-template stub.
 */

const ORG_ID = 'org_0123456789abcdef0123456789ab';

describe('Story 4.3: the NOTIFY bridge', () => {
  it('reports a refused pg_notify, and neither throws nor skips later handlers', async () => {
    const reported: { error: unknown; event: Action<unknown> }[] = [];
    const bus = eventBus({
      onHandlerError: (error, event) => reported.push({ error, event }),
    });
    const refusal = new Error('pg_notify refused');
    const refusingSql = (() => Promise.reject(refusal)) as unknown as Sql;
    registerNotifyBridge(bus, refusingSql);

    const later: string[] = [];
    bus.on(incidentCreatedEvent.type, (event) => later.push(event.type));

    const event = incidentCreatedEvent(
      { id: 'incident-1', orgId: ORG_ID },
      { timestamp: Date.now() },
    );
    assert.doesNotThrow(() => bus.emit(event));
    assert.deepEqual(later, [incidentCreatedEvent.type]);

    await bus.drain();
    assert.equal(reported.length, 1);
    assert.equal(reported[0].error, refusal);
    assert.equal(reported[0].event, event);
  });

  it('sends the payload as one parameter on watchdog_events', async () => {
    const sent: unknown[][] = [];
    const recordingSql = ((_: TemplateStringsArray, ...values: unknown[]) => {
      sent.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    const bus = eventBus({
      onHandlerError: (error) => assert.fail(String(error)),
    });
    registerNotifyBridge(bus, recordingSql);

    const timestamp = Date.UTC(2026, 9, 18);
    bus.emit(
      incidentCreatedEvent({ id: 'incident-1', orgId: ORG_ID }, { timestamp }),
    );
    // Not bridged: DOMAIN marks it "No".
    bus.emit(
      monitorCreatedEvent(
        {
          orgId: ORG_ID,
          monitorId: 'monitor-1',
          serviceId: 'service-1',
          monitorName: 'Checkout health',
        },
        { timestamp },
      ),
    );
    await bus.drain();

    assert.equal(sent.length, 1);
    const [channel, payload] = sent[0];
    assert.equal(channel, NOTIFY_CHANNEL);
    assert.deepEqual(JSON.parse(payload as string), {
      eventName: 'incident.created',
      orgId: ORG_ID,
      aggregateType: 'incident',
      aggregateId: 'incident-1',
      occurredAt: new Date(timestamp).toISOString(),
      version: 1,
    });
  });
});
