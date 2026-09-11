export type Meta = null | Record<string, any>;

export interface Action<Payload> {
  type: string;
  payload: Payload;
  meta?: Meta;
}

export interface CommandCreator<Payload> {
  type: string;

  (payload: Payload, meta?: Meta): Action<Payload>;
}

export type CommandHandler = (command: Action<any>) => Promise<any>;
/**
 * May be sync or async, and may return anything. The bus ignores the result
 * except to catch a rejected promise, and it contains a throw rather than
 * letting it reach the emitter; see event-bus.ts. `unknown`, not
 * `void | Promise<unknown>`: the union would reject the everyday listener
 * written as an expression, such as `() => seen.push(x)`.
 */
export type EventHandler = (event: Action<any>) => unknown;

export interface CommandBus {
  register(type: string, handler: CommandHandler): void;
  unregister(type: string): void;
  execute<R>(command: Action<any>): Promise<R>;
  addMiddleware(fn: Middleware): void;
}

export interface EventBus {
  on(type: string, handler: EventHandler): void;
  emit(event: Action<any>): void;
  addMiddleware(fn: Middleware): void;
}

/**
 * Wraps a handler call and returns what the handler returned. It does not
 * return a handler, which is what the previous declaration claimed.
 */
export type Middleware = (
  action: Action<unknown>,
  handler: CommandHandler | EventHandler,
) => Promise<unknown>;
