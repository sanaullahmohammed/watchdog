import type {
  RealtimeHub,
  RealtimeSignal,
} from '@/shared/realtime/realtime-hub';

/**
 * One admin subscription's view of the hub, as the async iterator a GraphQL
 * subscription returns (story 4.7).
 *
 * The hub delivers synchronously and never waits for a reader, so signals are
 * queued here until the socket asks for the next one. The queue is bounded: a
 * reader that falls `MAX_QUEUED_SIGNALS` behind has its queue replaced by one
 * `resync`, which tells it to re-read everything, and later events queue
 * behind that. A `resync` while one is already queued says nothing new and is
 * dropped. `closed` ends the iterator once what was queued has been read.
 */

export type OrganizationEvent = {
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
};

export const MAX_QUEUED_SIGNALS = 100;

const RESYNC = 'resync';

type Result = IteratorResult<OrganizationEvent, undefined>;

const DONE: Result = { done: true, value: undefined };

export function adminSignals(
  hub: Pick<RealtimeHub, 'subscribeAdmin'>,
  orgId: string,
): AsyncIterableIterator<OrganizationEvent, undefined> {
  const queue: OrganizationEvent[] = [];
  const waiting: Array<(result: Result) => void> = [];
  /** No more signals will be queued: the hub closed, or the reader returned. */
  let ended = false;
  let unsubscribe: (() => void) | undefined;

  const resync = (): OrganizationEvent => ({
    eventName: RESYNC,
    aggregateType: 'organization',
    aggregateId: orgId,
    occurredAt: new Date().toISOString(),
  });

  const isResync = (event: OrganizationEvent) =>
    event.eventName === RESYNC && event.aggregateType === 'organization';

  const enqueue = (event: OrganizationEvent) => {
    const waiter = waiting.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    if (isResync(event) && queue.some(isResync)) return;
    if (queue.length >= MAX_QUEUED_SIGNALS) {
      // The reader is too far behind to catch up signal by signal. One
      // re-read covers everything dropped here, this signal included.
      queue.splice(0, queue.length, resync());
      return;
    }
    queue.push(event);
  };

  const end = () => {
    if (ended) return;
    ended = true;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const waiter of waiting.splice(0)) waiter(DONE);
  };

  const onSignal = (signal: RealtimeSignal) => {
    if (ended) return;
    switch (signal.kind) {
      case 'event': {
        const { eventName, aggregateType, aggregateId, occurredAt } =
          signal.event;
        enqueue({ eventName, aggregateType, aggregateId, occurredAt });
        return;
      }
      case 'resync':
        enqueue(resync());
        return;
      case 'closed':
        end();
        return;
    }
  };

  const off = hub.subscribeAdmin(orgId, onSignal);
  // A closed hub sends `closed` during the subscribe call, before `off`
  // exists, so the iterator has already ended and only `off` is left to call.
  if (ended) off();
  else unsubscribe = off;

  const iterator: AsyncIterableIterator<OrganizationEvent, undefined> = {
    next(): Promise<Result> {
      const value = queue.shift();
      if (value) return Promise.resolve({ done: false, value });
      if (ended) return Promise.resolve(DONE);
      return new Promise((resolve) => waiting.push(resolve));
    },

    return(): Promise<Result> {
      // The reader is gone: what is queued will never be read.
      queue.length = 0;
      end();
      return Promise.resolve(DONE);
    },

    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}
