import { pipe } from 'ramda';
import type {
  Action,
  EventBus,
  EventHandler,
  Middleware,
} from '@/shared/cqrs/bus.types';

/**
 * Receives a handler's failure. The bus calls it and carries on, so it must
 * not throw; if it does, that is swallowed too.
 */
export type HandlerErrorReporter = (
  error: unknown,
  event: Action<unknown>,
) => void;

const reportToConsole: HandlerErrorReporter = (error, event) => {
  console.error(`Event handler for ${event.type} failed`, error);
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

export function eventBus({
  onHandlerError = reportToConsole,
}: {
  onHandlerError?: HandlerErrorReporter;
} = {}): EventBus {
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

  function report(error: unknown, event: Action<unknown>) {
    try {
      onHandlerError(error, event);
    } catch {
      // A reporter that fails must not undo the isolation it exists to record.
    }
  }

  function invoke(event: Action<unknown>, handler: EventHandler) {
    try {
      const result: unknown =
        middlewares.length > 0
          ? (pipe as any)(...middlewares)(event, handler)
          : handler(event);
      if (isThenable(result)) {
        result.then(undefined, (error: unknown) => report(error, event));
      }
    } catch (error) {
      report(error, event);
    }
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

    // Each handler is isolated from the others and from the emitter. Events are
    // emitted after the emitting command commits, so a handler's failure cannot
    // undo that work. Letting it propagate would only turn a committed change
    // into an error response and skip every handler after it. A rejected
    // promise would go unhandled and could end the process. It is contained and
    // reported instead. ARCHITECTURE.md 5.1; Epic 2 retrospective, R-4.
    for (const handler of [...registered]) {
      invoke(event, handler);
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
