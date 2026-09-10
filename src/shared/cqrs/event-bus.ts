import { pipe } from 'ramda';
import type {
  Action,
  EventBus,
  EventHandler,
  Middleware,
} from '@/shared/cqrs/bus.types';

export function eventBus(): EventBus {
  // A list per type, not a single handler. ARCHITECTURE.md section 5.2 needs
  // several independent reactions to one event - the NOTIFY bridge fans out to
  // clients while a module recomputes derived state - and a Map to one handler
  // would let the second registration silently replace the first.
  const handlers = new Map<string, EventHandler[]>();
  const middlewares: Middleware[] = [];

  function on<T extends string = string>(type: T, handler: EventHandler): void {
    if (typeof type !== 'string') {
      throw new TypeError('type must be a string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    handlers.set(type, [...(handlers.get(type) ?? []), handler]);
  }

  function emit(event: Action<unknown>): void {
    if (!event || typeof event !== 'object') {
      throw new TypeError('event must be an object');
    }
    if (typeof event.type !== 'string') {
      throw new TypeError('event.type must be a string');
    }

    // No subscriber is not an error. Domain events are fire-and-forget: an
    // event is emitted because it happened, not because something is listening.
    // Most of DOMAIN.md's catalog has no in-process reaction at all - it exists
    // to be bridged to NOTIFY, or simply to be part of the record.
    const registered = handlers.get(event.type) ?? [];

    for (const handler of registered) {
      if (middlewares.length > 0) {
        const list = (pipe as any)(...middlewares);
        list(event, handler);
      } else {
        handler(event);
      }
    }
  }

  function addMiddleware(fn: Middleware) {
    middlewares.push(fn);
  }

  return {
    on,
    emit,
    addMiddleware,
  };
}
