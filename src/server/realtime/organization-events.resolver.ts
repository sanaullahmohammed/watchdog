import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { ErrorWithProps, type MercuriusContext } from 'mercurius';
import env from '@/config/env';
import {
  type OrganizationContext,
  resolveOrganizationContext,
  stillHasAccess,
  UnknownOrganizationRoleError,
} from '@/server/auth/organization-context';
import { logFailure } from '@/server/error-logging';
import { recheckLookupDeadlineMs } from '@/server/realtime/access-recheck';
import {
  adminSignals,
  type OrganizationEvent,
} from '@/server/realtime/hub-iterator';

/**
 * `Subscription.organizationEvents`: the admin dashboard's live channel
 * (story 4.7, ARCHITECTURE 5.5). Every bridged event of the subscriber's
 * active organization, admin-only ones included, as a signal the client
 * re-reads from.
 *
 * Who is subscribing is read from the upgrade request's own headers, copied
 * when the socket was upgraded (`src/server/index.ts`). Never from
 * `ctx.reply.request.headers`: mercurius merges the `connection_init`
 * payload's headers into those at every subscription start, so a cookie sent
 * in a payload would authenticate. `subscribe` resolves who is subscribing
 * once per socket, and every `subscribe` on it shares that answer, so a frame
 * of pipelined subscribes costs one lookup here, beside the one the anonymous
 * limit's rationing hook makes for an upgrade that carries a cookie.
 *
 * A refusal is never thrown from `subscribe`: mercurius would log it at
 * `error` and send it as it is. It is returned instead, as an iterator whose
 * first `next()` rejects with it, which mercurius sends as the same `error`
 * message without logging. Each refusal is logged here, through `logFailure`,
 * by who caused it. Every error a client reads from here is one it is meant
 * to read: `UNAUTHENTICATED`, which then closes the socket with 4401; a masked
 * `INTERNAL_SERVER_ERROR` carrying the correlation id the original was logged
 * under, which closes it with 4500, so the client reconnects rather than
 * treating its session as invalid; or `TOO_MANY_SUBSCRIPTIONS`, which leaves
 * the socket and its live subscriptions open.
 *
 * Access is re-checked, not only resolved at open (story 4.8). Once a socket
 * has its first accepted subscription, it re-checks every
 * `ADMIN_SUBSCRIPTION_RECHECK_SECONDS` for as long as it lives, idle or not:
 * the upgrade's session must still be live and still the admitted user's,
 * and that user still a member, on the ladder, of the organization the socket
 * was admitted for, whatever the session's active organization now is. Lost
 * access closes the socket with 4401, ending every subscription on it and the
 * cached admission with it; a lookup that fails or does not settle in time
 * closes it with 4500. The bound is one interval plus the next re-check's
 * lookup, which is cut off at min(interval, 10 s), and events published before
 * the close may still arrive. The re-check never refreshes the session, so a
 * long-lived socket cannot keep its own session alive.
 *
 * Registered explicitly by `src/server/index.ts`, since the resolver
 * autoloader reads only `src/modules`.
 */

/** How many live subscriptions one socket may hold. */
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 10;

/** graphql-transport-ws's close code for a refused subscriber. */
const UNAUTHORIZED_CLOSE_CODE = 4401;

/** A close code for a server fault the client should retry past. */
const INTERNAL_ERROR_CLOSE_CODE = 4500;

/** graphql-transport-ws's close code for a reused subscription id. */
const DUPLICATE_ID_CLOSE_CODE = 4409;

/** ws's `readyState` for an open socket. */
const WS_OPEN = 1;

type SubscriptionSocket = NonNullable<MercuriusContext['socket']>;

/** Who is subscribing on a socket, decided once. */
type Admission =
  | { kind: 'admitted'; orgId: string; userId: string }
  | { kind: 'refused'; error: ErrorWithProps; closeCode: number };

/** One socket's subscriptions, as this resolver knows them. */
type SocketState = {
  admission?: Promise<Admission>;
  /** Every subscription id on the socket, being admitted or accepted. */
  live: Map<string, object>;
  /** The subscriptions accepted and not yet ended. */
  accepted: Set<object>;
  /** Set once the socket's access re-check has started. */
  rechecking?: true;
};

type Done = IteratorResult<OrganizationEvent, undefined>;

const DONE: Done = { done: true, value: undefined };

/** The upgrade request's logger, so a refusal carries its request id. */
const logOf = (ctx: MercuriusContext) => ctx.reply?.request?.log ?? ctx.app.log;

const unauthenticated = () =>
  new ErrorWithProps('Authentication required', { code: 'UNAUTHENTICATED' });

/**
 * Decides, from the lookup of who is subscribing, whether a socket may
 * subscribe, and logs a refusal once, by who caused it.
 */
async function admit(
  ctx: MercuriusContext,
  lookup: Promise<OrganizationContext | null>,
): Promise<Admission> {
  const log = logOf(ctx);
  try {
    const context = await lookup;
    if (context) {
      return { kind: 'admitted', orgId: context.orgId, userId: context.userId };
    }
    const error = unauthenticated();
    logFailure(log, error, 401, randomUUID());
    return { kind: 'refused', error, closeCode: UNAUTHORIZED_CLOSE_CODE };
  } catch (error) {
    if (error instanceof UnknownOrganizationRoleError) {
      // A membership the ladder does not know grants nothing.
      logFailure(log, error, 401, randomUUID());
      return {
        kind: 'refused',
        error: unauthenticated(),
        closeCode: UNAUTHORIZED_CLOSE_CODE,
      };
    }
    const correlationId = randomUUID();
    logFailure(
      log,
      error instanceof Error ? error : new Error(String(error)),
      500,
      correlationId,
    );
    return {
      kind: 'refused',
      error: new ErrorWithProps('Internal Server Error', {
        code: 'INTERNAL_SERVER_ERROR',
        correlationId,
      }),
      closeCode: INTERNAL_ERROR_CLOSE_CODE,
    };
  }
}

/**
 * An iterator whose first `next()` rejects with `error`, which mercurius sends
 * as the subscription's `error` message. `onSent` runs as that rejection is
 * handed over: mercurius writes the message from it within microtasks, so
 * anything `onSent` defers to the next turn of the event loop follows it.
 */
function refusal(
  error: Error,
  onSent?: () => void,
): AsyncIterableIterator<OrganizationEvent, undefined> {
  let used = false;
  const iterator: AsyncIterableIterator<OrganizationEvent, undefined> = {
    next() {
      if (used) return Promise.resolve(DONE);
      used = true;
      onSent?.();
      return Promise.reject(error);
    },
    return() {
      used = true;
      return Promise.resolve(DONE);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/** `promise`, or a rejection once `ms` has passed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The access re-check did not settle in ${ms}ms`)),
      ms,
    );
    timer.unref();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-checks the socket's access every `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`
 * until it closes. Each re-check is scheduled when the previous one has
 * finished, so two never overlap, and reads the interval then, never once.
 * A socket that is closing or closed, by the client or by `app.close()`, is
 * never logged, closed or rescheduled, whatever its lookup answers.
 */
function recheckAccess(
  socket: SubscriptionSocket,
  headers: Readonly<IncomingHttpHeaders>,
  admitted: { userId: string; orgId: string },
  upgradeLog: FastifyBaseLogger,
) {
  // Every line names whose access was re-checked.
  const log = upgradeLog.child({
    userId: admitted.userId,
    orgId: admitted.orgId,
  });
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const isOpen = () => !stopped && socket.readyState === WS_OPEN;

  const recheck = async () => {
    const intervalMs = env.realtime.adminSubscriptionRecheckSeconds * 1_000;
    try {
      const allowed = await within(
        stillHasAccess(headers, admitted),
        recheckLookupDeadlineMs(intervalMs),
      );
      if (!isOpen()) return;
      if (allowed) {
        schedule();
        return;
      }
      logFailure(log, new Error('Subscription access lost'), 401, randomUUID());
      socket.close(UNAUTHORIZED_CLOSE_CODE, 'Unauthorized');
    } catch (error) {
      if (!isOpen()) return;
      logFailure(
        log,
        error instanceof Error ? error : new Error(String(error)),
        500,
        randomUUID(),
      );
      // Fails closed: the client reconnects and is admitted afresh.
      socket.close(INTERNAL_ERROR_CLOSE_CODE, 'Internal error');
    }
  };

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      // `recheck` handles its own failures; this catches only a throw from
      // its logging or close. The socket is cut off rather than left open
      // with no re-check scheduled.
      recheck().catch(() => {
        try {
          socket.terminate();
        } catch {
          // Nothing more can be done.
        }
      });
    }, env.realtime.adminSubscriptionRecheckSeconds * 1_000);
    timer.unref();
  }

  socket.once('close', () => {
    stopped = true;
    clearTimeout(timer);
  });
  schedule();
}

/** An iterator that has already ended. */
function ended(): AsyncIterableIterator<OrganizationEvent, undefined> {
  const iterator: AsyncIterableIterator<OrganizationEvent, undefined> = {
    next: () => Promise.resolve(DONE),
    return: () => Promise.resolve(DONE),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

/** `inner`, calling `onEnd` once when it ends, by running out or by `return()`. */
function untilEnded(
  inner: AsyncIterableIterator<OrganizationEvent, undefined>,
  onEnd: () => void,
): AsyncIterableIterator<OrganizationEvent, undefined> {
  const iterator: AsyncIterableIterator<OrganizationEvent, undefined> = {
    async next() {
      const result = await inner.next();
      if (result.done) onEnd();
      return result;
    },
    async return() {
      onEnd();
      return (await inner.return?.()) ?? DONE;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

export default async function organizationEventsResolver(
  fastify: FastifyRouteInstance,
) {
  const states = new WeakMap<SubscriptionSocket, SocketState>();

  /** The socket's state. A context with no socket gets one of its own. */
  const stateOf = (socket: SubscriptionSocket | undefined): SocketState => {
    const fresh = (): SocketState => ({ live: new Map(), accepted: new Set() });
    if (!socket) return fresh();
    let state = states.get(socket);
    if (!state) {
      state = fresh();
      states.set(socket, state);
    }
    return state;
  };

  /**
   * Closes the socket once the refusal has been written: by the next turn of
   * the event loop, the error message is queued ahead of the close frame.
   */
  const closeAfterRefusal = (
    socket: SubscriptionSocket | undefined,
    code: number,
  ) => {
    if (!socket) return;
    setImmediate(() =>
      socket.close(
        code,
        code === UNAUTHORIZED_CLOSE_CODE ? 'Unauthorized' : 'Internal error',
      ),
    );
  };

  fastify.graphql.defineResolvers({
    Subscription: {
      organizationEvents: {
        subscribe: async (_root: unknown, _args: unknown, ctx) => {
          const socket = ctx.socket;
          const state = stateOf(socket);
          const id = String(ctx.id);

          // graphql-transport-ws: a reused live id closes the socket. mercurius
          // would otherwise overwrite the live iterator under that id and
          // orphan it, with its hub subscription, past the socket's close.
          if (state.live.has(id)) {
            // A fixed reason: one echoing the id could pass the 123 bytes a
            // close reason may hold, and ws would throw with the socket stuck.
            socket?.close(DUPLICATE_ID_CLOSE_CODE, 'Subscriber already exists');
            return ended();
          }
          const subscription = {};
          state.live.set(id, subscription);
          const untrack = () => {
            if (state.live.get(id) === subscription) state.live.delete(id);
            state.accepted.delete(subscription);
          };

          state.admission ??= admit(
            ctx,
            resolveOrganizationContext(ctx.upgradeHeaders ?? {}),
          );
          const admission = await state.admission;

          if (admission.kind === 'refused') {
            untrack();
            return refusal(admission.error, () =>
              closeAfterRefusal(socket, admission.closeCode),
            );
          }

          // The socket closed while this waited: mercurius ends what it is
          // handed, and nothing joins the hub.
          if (socket && socket.readyState !== WS_OPEN) {
            untrack();
            return ended();
          }

          if (state.accepted.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
            untrack();
            const error = new ErrorWithProps('Too many subscriptions', {
              code: 'TOO_MANY_SUBSCRIPTIONS',
            });
            logFailure(logOf(ctx), error, 429, randomUUID());
            return refusal(error);
          }

          state.accepted.add(subscription);
          ctx.clearSubscriptionDeadline?.();
          if (socket && !state.rechecking) {
            state.rechecking = true;
            recheckAccess(
              socket,
              ctx.upgradeHeaders ?? {},
              { userId: admission.userId, orgId: admission.orgId },
              logOf(ctx),
            );
          }
          return untilEnded(
            adminSignals(ctx.app.realtimeHub, admission.orgId),
            untrack,
          );
        },
        // The payload is the event itself; the default would read
        // `payload.organizationEvents`.
        resolve: (payload: unknown) => payload,
      },
    },
  });
}
