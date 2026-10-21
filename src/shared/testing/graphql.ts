import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { type IncomingHttpHeaders, request } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';

export type GraphqlError = {
  message: string;
  extensions?: { code?: string };
};

export type GraphqlResult<T = Record<string, unknown>> = {
  statusCode: number;
  body: { data: T | null; errors?: GraphqlError[] };
};

export type GraphqlOptions = {
  variables?: object;
  cookie?: string;
  headers?: Record<string, string>;
};

/**
 * Sends one GraphQL operation to `/graphql` and returns the raw inject
 * response, unparsed. `content-type: application/json` is always sent; the
 * cookie only when one is given, and `headers` are added after both.
 */
export function gqlResponse(
  app: FastifyInstance,
  query: string,
  options: GraphqlOptions = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.cookie) headers.cookie = options.cookie;
  Object.assign(headers, options.headers);
  return app.inject({
    method: 'POST',
    url: '/graphql',
    headers,
    payload: { query, variables: options.variables },
  });
}

/**
 * Sends one GraphQL operation over HTTP and returns the status with the
 * parsed body. `T` types `data`.
 */
export async function gql<T = Record<string, unknown>>(
  app: FastifyInstance,
  query: string,
  options: GraphqlOptions = {},
): Promise<GraphqlResult<T>> {
  const response = await gqlResponse(app, query, options);
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as GraphqlResult<T>['body'],
  };
}

/** Sends an operation, asserts the response has no `errors`, returns `data`. */
export async function gqlData<T = Record<string, unknown>>(
  app: FastifyInstance,
  query: string,
  options: GraphqlOptions = {},
): Promise<T> {
  const { statusCode, body } = await gql<T>(app, query, options);
  const detail = `status ${statusCode}: ${JSON.stringify(body)}`;
  assert.equal(body.errors, undefined, detail);
  assert.notEqual(body.data, null, detail);
  return body.data as T;
}

/** One graphql-transport-ws message, as the server sent it. */
export type WsMessage = {
  type: string;
  id?: string;
  payload?: unknown;
};

export type WsClose = { code: number; reason: string };

export type SubscriptionClient = {
  /** Sends `subscribe` for `query` under a fresh id, and returns the id. */
  subscribe(query: string): string;
  /** Sends any protocol message, such as a second `connection_init`. */
  send(message: object): void;
  /** The next message not yet read; fails after `timeoutMs`. */
  next(timeoutMs?: number): Promise<WsMessage>;
  /** Settles when the socket has closed, with the server's code. */
  closed: Promise<WsClose>;
  /** `closed`, failing after `timeoutMs`. */
  waitClosed(timeoutMs?: number): Promise<WsClose>;
  /** Closes the socket and waits until it has. */
  close(): Promise<WsClose>;
};

export type SubscriptionOptions = {
  cookie?: string;
  origin?: string;
  /** The `connection_init` payload. */
  payload?: object;
  /** Sends `connection_init` and waits for the ack. Default true. */
  init?: boolean;
};

const WS_WAIT_MS = 5_000;

/**
 * `promise`, or a rejection once `WS_WAIT_MS` has passed, so a server that
 * never answers fails the test rather than stalling the run. `onTimeout`
 * releases whatever was waiting.
 */
function withDeadline<T>(
  promise: Promise<T>,
  what: string,
  onTimeout: () => void,
  timeoutMs = WS_WAIT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${what} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Opens a WebSocket to `/graphql` speaking `graphql-transport-ws` (story 4.7),
 * with Node's global `WebSocket`, which sends `Cookie` and `Origin` only when
 * they are passed as headers. `baseUrl` is what `app.listen` returned. By
 * default it initialises the connection and waits for `connection_ack`.
 */
export async function openSubscription(
  baseUrl: string,
  { cookie, origin, payload, init = true }: SubscriptionOptions = {},
): Promise<SubscriptionClient> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const url = `${baseUrl.replace(/^http/, 'ws')}/graphql`;
  // `headers` is undici's extension to the WebSocket constructor.
  const socket = new WebSocket(url, {
    protocols: ['graphql-transport-ws'],
    headers,
  } as unknown as string[]);

  const unread: WsMessage[] = [];
  const waiting: Array<(message: WsMessage) => void> = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as WsMessage;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else unread.push(message);
  });
  const closed = new Promise<WsClose>((resolve) =>
    socket.addEventListener('close', (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );

  await withDeadline(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`the upgrade to ${url} failed`)),
        { once: true },
      );
    }),
    `the upgrade to ${url}`,
    () => socket.close(),
  );

  let ids = 0;
  const send = (message: object) => socket.send(JSON.stringify(message));

  function next(timeoutMs = WS_WAIT_MS): Promise<WsMessage> {
    const message = unread.shift();
    if (message) return Promise.resolve(message);
    let timer: NodeJS.Timeout | undefined;
    return new Promise<WsMessage>((resolve, reject) => {
      const waiter = (arrived: WsMessage) => {
        clearTimeout(timer);
        resolve(arrived);
      };
      waiting.push(waiter);
      timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1);
        reject(new Error(`no message on ${url} within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  const client: SubscriptionClient = {
    subscribe(query) {
      ids += 1;
      const id = String(ids);
      send({ id, type: 'subscribe', payload: { query } });
      return id;
    },
    send,
    next,
    closed,
    waitClosed: (timeoutMs = WS_WAIT_MS) =>
      withDeadline(closed, `the close of ${url}`, () => {}, timeoutMs),
    async close() {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      return withDeadline(closed, `the close of ${url}`, () => {});
    },
  };

  if (init) {
    send({ type: 'connection_init', payload });
    const ack = await next();
    assert.equal(ack.type, 'connection_ack', JSON.stringify(ack));
  }
  return client;
}

export type RawUpgrade = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  /** The upgraded socket, on a 101; it is left open and never answered. */
  socket?: Socket;
};

/**
 * A raw `http` upgrade to `/graphql`. `WebSocket` hides the status of a
 * refused upgrade, and this reads it. On a 101 the socket is returned open:
 * nothing is read from it or written to it, so it never answers a close frame.
 */
export function rawUpgrade(
  baseUrl: string,
  headers: Record<string, string> = {},
): Promise<RawUpgrade> {
  const { hostname, port } = new URL(baseUrl);
  let req: ReturnType<typeof request> | undefined;
  const upgrade = new Promise<RawUpgrade>((resolve, reject) => {
    req = request({
      host: hostname,
      port,
      path: '/graphql',
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-protocol': 'graphql-transport-ws',
        ...headers,
      },
    });
    req.on('error', reject);
    req.on('upgrade', (res, socket) =>
      resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        socket,
      }),
    );
    req.on('response', (res) => {
      res.resume();
      resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
    });
    req.end();
  });
  return withDeadline(upgrade, `the raw upgrade to ${baseUrl}/graphql`, () =>
    req?.destroy(),
  );
}

/** The status a raw upgrade is answered with; an upgraded socket is closed. */
export async function upgradeStatus(
  baseUrl: string,
  headers: Record<string, string> = {},
): Promise<RawUpgrade> {
  const upgrade = await rawUpgrade(baseUrl, headers);
  upgrade.socket?.destroy();
  return { statusCode: upgrade.statusCode, headers: upgrade.headers };
}
