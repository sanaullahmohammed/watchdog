import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config';
import config from '@/config/env';
import { publicPageETag } from '@/modules/status-page/dtos/public-status-page.etag';
import type { PublicStatusPageResponseDto } from '@/modules/status-page/dtos/public-status-page.response.dto';
import { openPublicStatusEventStreamQuery } from '@/modules/status-page/queries/open-public-status-stream/open-public-status-stream.handler';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { monitorThresholdBreachedEvent } from '@/shared/events/monitor.events';
import {
  archiveService,
  createService,
  declareIncident,
  openMonitorDraft,
  scheduleMaintenance,
  transitionDueMaintenance,
  transitionIncident,
  updateService,
} from '@/shared/testing/fixtures';
import { notifyRaw, subscribeForOrg } from '@/shared/testing/notifications';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/**
 * Story 4.5: `GET /status/:orgSlug/events` opens a public stream of the page.
 *
 * Streams are real sockets, not `app.inject`: a hijacked reply, a client that
 * goes away and a server that closes under open streams only behave as they
 * do in production over a connection. `node:http` rather than `fetch`, because
 * it can bind a second loopback address, which is how a test has two client
 * IPs.
 *
 * The in-process app keeps the default caps. The total cap, the lifetime and
 * the heartbeat are tried against a spawned api with small values, since
 * configuration is read once per process.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const tag = `sse-${randomBytes(4).toString('hex')}`;
const ORIGIN = 'https://example.test';
const WAIT_MS = 15_000;

/** The spawned api's bounds, small enough to wait for. */
const SPAWNED = {
  maxTotal: 2,
  lifetimeSeconds: 3,
  heartbeatSeconds: 1,
};

let app: FastifyInstance;
let port = 0;
let userId = '';
let orgId = '';

/** Counts the hub subscriptions the route takes and gives back. */
const subscriptions = {
  taken: 0,
  released: 0,
  waiters: [] as Array<() => void>,
  /** When set, the next subscription throws instead, and clears this. */
  throwNext: false,
};

type Stream = {
  status: number;
  headers: IncomingHttpHeaders;
  /** The next `\n\n`-terminated frame, without its terminator. */
  nextFrame(): Promise<string>;
  /** The whole body, once the response has ended. */
  text(): Promise<string>;
  /** Settles when the response ends: true when cleanly, false when cut off. */
  ended: Promise<boolean>;
  /** Every frame received so far, with when it arrived. */
  /** Each frame with when it arrived, on the monotonic clock: on WSL2 the wall
   * clock steps back by up to 1.4 s (AGENTS.md), which would shrink a gap. */
  received: Array<{ frame: string; at: number }>;
  close(): void;
};

function open(
  path: string,
  {
    to = port,
    headers = {},
    localAddress = '127.0.0.1',
    method = 'GET',
  }: {
    to?: number;
    headers?: Record<string, string>;
    localAddress?: string;
    method?: string;
  } = {},
): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: to,
      path,
      method,
      localAddress,
      // A connection of its own, so closing a stream closes only it.
      agent: false,
      headers: { origin: ORIGIN, ...headers },
    });
    req.on('error', reject);
    req.on('response', (res: IncomingMessage) => {
      res.setEncoding('utf8');
      let body = '';
      let buffer = '';
      const frames: string[] = [];
      const waiting: Array<(frame: string) => void> = [];
      const received: Array<{ frame: string; at: number }> = [];
      res.on('data', (chunk: string) => {
        body += chunk;
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf('\n\n');
          if (at < 0) break;
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          received.push({ frame, at: performance.now() });
          const waiter = waiting.shift();
          if (waiter) waiter(frame);
          else frames.push(frame);
        }
      });
      const ended = new Promise<boolean>((settle) => {
        res.on('end', () => settle(true));
        res.on('aborted', () => settle(false));
        res.on('error', () => settle(false));
        res.on('close', () => settle(res.complete));
      });
      // A stream cut off by the test's own close is not a failure.
      req.removeListener('error', reject);
      req.on('error', () => undefined);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        nextFrame: () => {
          const frame = frames.shift();
          if (frame !== undefined) return Promise.resolve(frame);
          return withTimeout(
            new Promise<string>((take) => waiting.push(take)),
            'the next frame',
          );
        },
        text: async () => {
          await ended;
          return body;
        },
        ended,
        received,
        close: () => req.destroy(),
      });
    });
    req.end();
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  what: string,
  ms = WAIT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what}`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolves once the route has given back `count` subscriptions in all. */
function released(count: number): Promise<void> {
  if (subscriptions.released >= count) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve) => {
      const check = () => {
        if (subscriptions.released >= count) resolve();
        else subscriptions.waiters.push(check);
      };
      check();
    }),
    `${count} released subscriptions`,
  );
}

/** The fields of an SSE frame, by name; a comment is under `''`. */
function fields(frame: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const line of frame.split('\n')) {
    const at = line.indexOf(':');
    const name = at < 0 ? line : line.slice(0, at);
    const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
    byName.set(name, value);
  }
  return byName;
}

const withoutGeneratedAt = (page: Record<string, unknown>) => {
  const { generatedAt: _, ...rest } = page;
  return rest;
};

/** The three public headers, and never credentials. */
const assertPublicHeaders = (
  headers: Record<string, unknown>,
  label?: string,
) => {
  assert.equal(headers['access-control-allow-origin'], '*', label);
  assert.equal(
    headers['access-control-expose-headers'],
    'ETag, Retry-After',
    label,
  );
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin', label);
  assert.equal(headers['access-control-allow-credentials'], undefined, label);
};

/** The page's own miss, the answer every miss under the stream must equal. */
async function pageMiss() {
  const miss = await app.inject({
    method: 'GET',
    url: `/status/${tag}-missing`,
    headers: { origin: ORIGIN },
  });
  assert.equal(miss.statusCode, 404);
  const { correlationId: _, ...body } = miss.json();
  return body;
}

type SpawnedApi = { child: ChildProcess; port: number; output: () => string };

async function spawnApi(extra: Record<string, string>): Promise<SpawnedApi> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', 'api'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // The application role, which passes the api's role guard.
        DATABASE_URL: config.db.url,
        HOST: '127.0.0.1',
        PORT: '0',
        LOG_LEVEL: 'info',
        ...extra,
      },
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const listening = output.match(/listening at http:\/\/127\.0\.0\.1:(\d+)/);
    if (listening && output.includes('Server is ready')) {
      return { child, port: Number(listening[1]), output: () => output };
    }
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      Date.now() > deadline
    ) {
      child.kill('SIGKILL');
      throw new Error(`the api did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopApi(api: SpawnedApi) {
  if (api.child.exitCode !== null || api.child.signalCode !== null) return;
  const exit = new Promise((resolve) => api.child.on('close', resolve));
  api.child.kill('SIGTERM');
  const guard = setTimeout(() => api.child.kill('SIGKILL'), 30_000);
  await exit;
  clearTimeout(guard);
}

describe('Story 4.5: open a public status stream', () => {
  let spawned: SpawnedApi | undefined;

  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    let cookie = '';
    ({ cookie, userId, orgId } = await signUpWithOrg(app, tag));
    await createService(app, cookie, { name: 'Checkout' });
    await app.eventBus.drain();

    const hub = app.realtimeHub;
    const subscribePublic = hub.subscribePublic;
    hub.subscribePublic = (id, fn) => {
      if (subscriptions.throwNext) {
        subscriptions.throwNext = false;
        throw new Error('subscription refused by the test');
      }
      subscriptions.taken += 1;
      const off = subscribePublic(id, fn);
      let once = false;
      return () => {
        off();
        if (once) return;
        once = true;
        subscriptions.released += 1;
        for (const waiter of subscriptions.waiters.splice(0)) waiter();
      };
    };

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  after(async () => {
    if (spawned) await stopApi(spawned);
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
    // Normally already closed by the last test.
    await app.close().catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  it('opens with the page as its first event, tagged with the page ETag', async () => {
    const stream = await open(`/status/${tag}/events`);
    try {
      assert.equal(stream.status, 200);
      assert.equal(
        stream.headers['content-type'],
        'text/event-stream; charset=utf-8',
      );
      assert.equal(stream.headers['cache-control'], 'no-store');
      assert.equal(stream.headers['x-accel-buffering'], 'no');
      assert.equal(stream.headers.etag, undefined, 'a stream has no ETag');
      assertPublicHeaders(stream.headers);

      const first = fields(await stream.nextFrame());
      assert.equal(first.has('event'), false, 'unnamed, for onmessage');
      const id = first.get('id');
      const data = first.get('data');
      assert.ok(id && data);

      const get = await app.inject({ method: 'GET', url: `/status/${tag}` });
      assert.equal(get.statusCode, 200);
      // Verbatim, quotes included, so a client compares it unchanged.
      assert.equal(id, get.headers.etag);
      assert.deepEqual(
        withoutGeneratedAt(JSON.parse(data)),
        withoutGeneratedAt(get.json()),
      );
      assert.equal(JSON.parse(data).groups.length > 0, true, 'not vacuous');
    } finally {
      stream.close();
    }
  });

  it('answers a miss as the page does, and opens nothing', async () => {
    const expected = await pageMiss();
    const taken = subscriptions.taken;
    for (const slug of [`${tag}-missing`, 'Not_A_Slug', 'a'.repeat(300)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/status/${slug}/events`,
        headers: { origin: ORIGIN },
      });
      const label = slug.slice(0, 40);
      assert.equal(res.statusCode, 404, `${label} ${res.body}`);
      assertPublicHeaders(res.headers, label);
      assert.match(String(res.headers['content-type']), /application\/json/);
      const { correlationId, ...body } = res.json();
      assert.ok(correlationId, label);
      assert.deepEqual(body, expected, label);
    }
    assert.equal(subscriptions.taken, taken, 'no miss subscribed');
  });

  it('answers HEAD with the uniform miss, and opens nothing', async () => {
    const taken = subscriptions.taken;
    const head = await app.inject({
      method: 'HEAD',
      url: `/status/${tag}/events`,
      headers: { origin: ORIGIN },
    });
    assert.equal(head.statusCode, 404);
    assert.equal(head.body, '');
    assertPublicHeaders(head.headers);
    assert.equal(subscriptions.taken, taken);
  });

  it('answers its preflight without reading data or being rationed', async () => {
    // A slug nobody has: a preflight that read the database would 404.
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/status/x/events',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'last-event-id',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assertPublicHeaders(preflight.headers);
    assert.equal(
      preflight.headers['access-control-allow-methods'],
      'GET, OPTIONS',
    );
    assert.equal(
      preflight.headers['access-control-allow-headers'],
      'last-event-id',
    );
    assert.equal(preflight.headers['access-control-max-age'], '86400');
    assert.equal(
      preflight.headers['x-ratelimit-limit'],
      undefined,
      'the preflight is not rationed',
    );
  });

  it('ignores Last-Event-ID and opens with the current page', async () => {
    const stream = await open(`/status/${tag}/events`, {
      headers: { 'last-event-id': '"stale"' },
    });
    try {
      assert.equal(stream.status, 200);
      const first = fields(await stream.nextFrame());
      const get = await app.inject({ method: 'GET', url: `/status/${tag}` });
      assert.equal(first.get('id'), get.headers.etag);
    } finally {
      stream.close();
    }

    // A client that already holds the current page is sent it all the same:
    // no id is compared, so nothing is skipped.
    const current = await app.inject({ method: 'GET', url: `/status/${tag}` });
    const etag = current.headers.etag as string;
    const resumed = await open(`/status/${tag}/events`, {
      headers: { 'last-event-id': etag },
    });
    try {
      assert.equal(resumed.status, 200);
      const first = fields(await resumed.nextFrame());
      assert.equal(first.get('id'), etag);
      assert.deepEqual(
        withoutGeneratedAt(JSON.parse(first.get('data') ?? '{}')),
        withoutGeneratedAt(current.json()),
      );
    } finally {
      resumed.close();
    }
  });

  it('cuts a stream off and gives everything back when it fails after the hijack', async () => {
    const ip = '127.0.0.6';
    const taken = subscriptions.taken;
    subscriptions.throwNext = true;
    // The socket is destroyed in the tick the head was written, so the head
    // may never leave: a hang-up and a response cut off are the same failure.
    const cutOff = await open(`/status/${tag}/events`, {
      localAddress: ip,
    }).then(
      (failed) => withTimeout(failed.ended, 'the cut-off').then((end) => !end),
      (error: NodeJS.ErrnoException) =>
        error.code === 'ECONNRESET' || error.message === 'socket hang up',
    );
    assert.equal(cutOff, true, 'the stream did not end cleanly');
    assert.equal(subscriptions.throwNext, false, 'the failure happened');
    assert.equal(subscriptions.taken, taken, 'no subscription was taken');

    // Its place was given back: the IP can still open all of its own.
    const streams: Stream[] = [];
    try {
      for (let n = 0; n < env.publicSurface.stream.maxPerIp; n += 1) {
        const stream = await open(`/status/${tag}/events`, {
          localAddress: ip,
        });
        streams.push(stream);
        assert.equal(stream.status, 200, `stream ${n + 1}`);
      }
    } finally {
      for (const stream of streams) stream.close();
    }
  });

  it('admits nothing for a client gone while the page was composed', async () => {
    const ip = '127.0.0.3';
    const bus = app.queryBus;
    const execute = bus.execute;
    let composed!: () => void;
    const composing = new Promise<void>((resolve) => {
      composed = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let serverSawClose!: () => void;
    const closedOnServer = new Promise<void>((resolve) => {
      serverSawClose = resolve;
    });
    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      if (req.socket.remoteAddress === ip) res.once('close', serverSawClose);
    };

    bus.execute = (async (action: Parameters<typeof execute>[0]) => {
      const result = await execute.call(bus, action);
      if (action.type === openPublicStatusEventStreamQuery.type) {
        composed();
        await gate;
      }
      return result;
    }) as typeof execute;
    app.server.on('request', onRequest);
    const taken = subscriptions.taken;
    try {
      const req = request({
        host: '127.0.0.1',
        port,
        path: `/status/${tag}/events`,
        localAddress: ip,
        agent: false,
      });
      req.on('error', () => undefined);
      req.end();
      await withTimeout(composing, 'the page to be composed');
      req.destroy();
      await withTimeout(closedOnServer, 'the server to see the close');
      release();
      // The handler runs on from the composition without an await.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      bus.execute = execute;
      app.server.off('request', onRequest);
    }

    assert.equal(subscriptions.taken, taken, 'nothing was subscribed');

    // Nothing was admitted either: the IP still has all its places.
    const streams: Stream[] = [];
    try {
      for (let n = 0; n < env.publicSurface.stream.maxPerIp; n += 1) {
        const stream = await open(`/status/${tag}/events`, {
          localAddress: ip,
        });
        streams.push(stream);
        assert.equal(stream.status, 200, `stream ${n + 1}`);
      }
      const over = await open(`/status/${tag}/events`, { localAddress: ip });
      assert.equal(over.status, 429, 'and no more');
    } finally {
      for (const stream of streams) stream.close();
    }
  });

  it('caps the streams one IP holds open, and frees a place when one closes', async () => {
    const ip = '127.0.0.4';
    const max = env.publicSurface.stream.maxPerIp;
    const streams: Stream[] = [];
    try {
      for (let n = 0; n < max; n += 1) {
        const stream = await open(`/status/${tag}/events`, {
          localAddress: ip,
        });
        streams.push(stream);
        assert.equal(stream.status, 200, `stream ${n + 1}`);
      }

      const refused = await open(`/status/${tag}/events`, {
        localAddress: ip,
      });
      assert.equal(refused.status, 429);
      assertPublicHeaders(refused.headers);
      const body = JSON.parse(await refused.text());
      assert.equal(body.statusCode, 429);
      assert.equal(body.error, 'Too Many Requests');

      // Another IP has places of its own.
      const other = await open(`/status/${tag}/events`, {
        localAddress: '127.0.0.5',
      });
      assert.equal(other.status, 200);
      other.close();

      // Close one of this IP's, and wait until the server has given back
      // every subscription but the nine still open: its own, and any closed
      // earlier (`other`, and the previous tests').
      streams.shift()?.close();
      await released(subscriptions.taken - streams.length);

      const next = await open(`/status/${tag}/events`, { localAddress: ip });
      streams.push(next);
      assert.equal(next.status, 200, 'the freed place is taken at once');
    } finally {
      for (const stream of streams) stream.close();
    }
  });

  it('rations openings like the page, in a bucket of their own', async () => {
    const limited = await buildApp({ logger: false });
    await limited.ready();
    try {
      const max = env.publicSurface.rateLimit.max;
      let refusedAt = 0;
      let refused: Awaited<ReturnType<typeof limited.inject>> | undefined;
      for (let sent = 1; sent <= max + 1 && !refused; sent += 1) {
        const res = await limited.inject({
          method: 'GET',
          url: `/status/${tag}-missing/events`,
          headers: { origin: ORIGIN },
        });
        if (res.statusCode === 429) {
          refused = res;
          refusedAt = sent;
        } else {
          assert.equal(res.statusCode, 404, res.body);
        }
      }
      assert.ok(refused, 'openings were not rationed');
      assert.equal(refusedAt, max + 1, "the page's size");
      assertPublicHeaders(refused.headers);
      assert.ok(refused.headers['retry-after']);

      // The page itself is still served: the stream spent its own bucket.
      const page = await limited.inject({
        method: 'GET',
        url: `/status/${tag}`,
      });
      assert.equal(page.statusCode, 200);
    } finally {
      await limited.close();
    }
  });

  describe('against an api with small bounds', () => {
    before(async () => {
      spawned = await spawnApi({
        PUBLIC_STREAM_MAX_TOTAL: String(SPAWNED.maxTotal),
        PUBLIC_STREAM_MAX_LIFETIME_SECONDS: String(SPAWNED.lifetimeSeconds),
        PUBLIC_STREAM_HEARTBEAT_SECONDS: String(SPAWNED.heartbeatSeconds),
      });
    });

    it('writes a heartbeat after an interval with nothing written', async () => {
      assert.ok(spawned);
      const stream = await open(`/status/${tag}/events`, { to: spawned.port });
      try {
        assert.equal(stream.status, 200, spawned.output());
        // Run to its lifetime, which also frees its place for the next test.
        assert.equal(await withTimeout(stream.ended, 'the lifetime'), true);

        const [opening, ...rest] = stream.received;
        assert.ok(opening && fields(opening.frame).has('data'));
        const beats = rest.filter(({ frame }) => frame === ': heartbeat');
        assert.equal(beats.length, rest.length, 'nothing else was written');
        assert.ok(beats.length >= 2, `it repeats: ${beats.length} heartbeats`);
        const interval = SPAWNED.heartbeatSeconds * 1000;
        assert.ok(
          beats[0].at - opening.at >= interval - 200,
          'not before the interval',
        );
        const gap = beats[1].at - beats[0].at;
        assert.ok(
          gap >= interval - 200 && gap <= interval + 1000,
          `the second one interval after the first: ${gap} ms`,
        );
      } finally {
        stream.close();
      }
    });

    it('caps the streams of the process, and ends each after its lifetime', async () => {
      assert.ok(spawned);
      const to = spawned.port;
      const opened = performance.now();
      const a = await open(`/status/${tag}/events`, { to });
      const b = await open(`/status/${tag}/events`, {
        to,
        localAddress: '127.0.0.2',
      });
      try {
        assert.equal(a.status, 200, spawned.output());
        assert.equal(b.status, 200);

        const c = await open(`/status/${tag}/events`, {
          to,
          localAddress: '127.0.0.3',
        });
        assert.equal(c.status, 429, 'any IP is refused once the total is held');
        assertPublicHeaders(c.headers);
        assert.equal(JSON.parse(await c.text()).statusCode, 429);

        // The server ends both, cleanly, at their lifetime.
        assert.equal(await withTimeout(a.ended, 'a to end'), true);
        assert.equal(await withTimeout(b.ended, 'b to end'), true);
        assert.ok(
          performance.now() - opened >= SPAWNED.lifetimeSeconds * 1000 - 500,
          'not before the lifetime',
        );

        // And frees their places.
        const again = await open(`/status/${tag}/events`, {
          to,
          localAddress: '127.0.0.3',
        });
        assert.equal(again.status, 200);
        again.close();
      } finally {
        a.close();
        b.close();
      }
    });

    // Last in this block: stops the spawned api.
    it('ends an open stream cleanly when the api is sent SIGTERM', async () => {
      assert.ok(spawned);
      const child = spawned.child;
      const stream = await open(`/status/${tag}/events`, {
        to: spawned.port,
        localAddress: '127.0.0.7',
      });
      assert.equal(stream.status, 200, spawned.output());
      await stream.nextFrame();

      const exit = new Promise<number | null>((resolve) =>
        child.on('close', resolve),
      );
      child.kill('SIGTERM');
      assert.equal(
        await withTimeout(stream.ended, 'the stream to end on SIGTERM'),
        true,
        spawned.output(),
      );
      // graceful-server exits with the signal's number, 15 for SIGTERM.
      assert.equal(
        await withTimeout(exit, 'the api to exit', 20_000),
        15,
        spawned.output(),
      );
    });
  });

  describe('Story 4.6: push the public page when it changes', () => {
    const tag6 = `psh-${randomBytes(4).toString('hex')}`;
    const slugA = `${tag6}-a`;
    const slugB = `${tag6}-b`;
    const slugC = `${tag6}-c`;
    let app6: FastifyInstance;
    let port6 = 0;
    const orgs = {
      a: { id: '', userId: '', cookie: '' },
      b: { id: '', userId: '', cookie: '' },
      c: { id: '', userId: '', cookie: '' },
    };
    const mine = new Set([slugA, slugB, slugC]);

    /** Compositions of this describe's own orgs, and a way to hold them. */
    const compositions = {
      count: 0,
      /** Since the last opening, by slug. */
      bySlug: new Map<string, number>(),
      inFlight: 0,
      failNext: false,
      gate: undefined as Promise<void> | undefined,
    };
    const hubReleases = {
      taken: 0,
      released: 0,
      waiters: [] as Array<() => void>,
    };

    const pageOf = (stream: Stream, index = -1) => {
      const entry = stream.received.at(index);
      assert.ok(entry, 'no frame');
      const f = fields(entry.frame);
      return {
        id: f.get('id') ?? '',
        page: JSON.parse(f.get('data') ?? '{}') as PublicStatusPageResponseDto,
      };
    };

    const tick = () => new Promise((resolve) => setImmediate(resolve));

    function hold() {
      let release!: () => void;
      compositions.gate = new Promise<void>((resolve) => {
        release = () => {
          compositions.gate = undefined;
          resolve();
        };
      });
      return release;
    }

    /** Resolves once every composition in flight has finished and been offered. */
    async function quiet() {
      for (let stable = 0; stable < 3; ) {
        await tick();
        stable = compositions.inFlight === 0 ? stable + 1 : 0;
      }
    }

    /** Waits for the hub to have delivered everything, and compositions to end. */
    async function settleOrg(orgId: string) {
      const sub = subscribeForOrg(app6.realtimeHub, orgId);
      try {
        await sub.settle(app6);
      } finally {
        sub.close();
      }
      await quiet();
    }

    async function releasedAll() {
      if (hubReleases.released >= hubReleases.taken) return;
      await withTimeout(
        new Promise<void>((resolve) => {
          const check = () => {
            if (hubReleases.released >= hubReleases.taken) resolve();
            else hubReleases.waiters.push(check);
          };
          check();
        }),
        'the streams to be given back',
      );
    }

    async function openPage(slug: string) {
      const stream = await open(`/status/${slug}/events`, { to: port6 });
      assert.equal(stream.status, 200);
      await stream.nextFrame();
      compositions.count = 0;
      compositions.bySlug.clear();
      return stream;
    }

    const getPage = async (slug: string) => {
      const res = await app6.inject({ method: 'GET', url: `/status/${slug}` });
      assert.equal(res.statusCode, 200, res.body);
      return { etag: res.headers.etag as string, page: res.json() };
    };

    /**
     * Reads frames until the last one is the page `GET` answers now, then
     * checks it equals that page. Status recomputation can add a second push.
     */
    async function converge(stream: Stream, slug: string) {
      await app6.eventBus.drain();
      for (;;) {
        const expected = await getPage(slug);
        if (stream.received.length > 0 && pageOf(stream).id === expected.etag) {
          assert.deepEqual(
            withoutGeneratedAt(pageOf(stream).page),
            withoutGeneratedAt(expected.page),
          );
          return expected.page as PublicStatusPageResponseDto;
        }
        await stream.nextFrame();
      }
    }

    function assertFramesTagged(stream: Stream) {
      for (const [index, { frame }] of stream.received.entries()) {
        const f = fields(frame);
        assert.equal(f.has('event'), false);
        assert.equal(
          f.get('id'),
          publicPageETag(JSON.parse(f.get('data') ?? '{}')),
          `frame ${index}`,
        );
      }
    }

    async function noFrameSince(stream: Stream, before: number, orgId: string) {
      await settleOrg(orgId);
      assert.equal(stream.received.length, before, 'no frame');
    }

    async function send(
      who: { cookie: string },
      method: 'PATCH' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      payload?: object,
    ) {
      const res = await app6.inject({
        method,
        url: `/api/v1${url}`,
        headers: { cookie: who.cookie, origin: TEST_ORIGIN },
        payload,
      });
      assert.ok(res.statusCode < 300, `${method} ${url}: ${res.body}`);
      return res;
    }

    let episode = 0;
    const draftOn = (serviceId: string) => {
      episode += 1;
      return openMonitorDraft(
        app6,
        orgs.a.cookie,
        orgs.a.id,
        serviceId,
        episode,
      );
    };

    let visible = '';
    let hidden = '';

    before(async () => {
      app6 = await buildApp({ logger: false }, { listen: true });
      await app6.ready();
      for (const [key, slug] of [
        ['a', slugA],
        ['b', slugB],
        ['c', slugC],
      ] as const) {
        const signedUp = await signUpWithOrg(app6, slug);
        orgs[key] = {
          id: signedUp.orgId,
          userId: signedUp.userId,
          cookie: signedUp.cookie,
        };
      }
      visible = await createService(app6, orgs.a.cookie, { name: 'Visible' });
      hidden = await createService(app6, orgs.a.cookie, {
        name: 'Hidden',
        isPublic: false,
      });
      await createService(app6, orgs.b.cookie, { name: 'Bee' });
      await createService(app6, orgs.c.cookie, { name: 'Sea' });
      await app6.eventBus.drain();

      const execute = app6.queryBus.execute;
      app6.queryBus.execute = (async (
        action: Parameters<typeof execute>[0],
      ) => {
        const payload = action.payload as { slug?: string } | undefined;
        if (
          action.type !== openPublicStatusEventStreamQuery.type ||
          !payload?.slug ||
          !mine.has(payload.slug)
        ) {
          return execute.call(app6.queryBus, action);
        }
        compositions.count += 1;
        compositions.bySlug.set(
          payload.slug,
          (compositions.bySlug.get(payload.slug) ?? 0) + 1,
        );
        compositions.inFlight += 1;
        try {
          if (compositions.gate) await compositions.gate;
          if (compositions.failNext) {
            compositions.failNext = false;
            throw new Error('composition failed by the test');
          }
          return await execute.call(app6.queryBus, action);
        } finally {
          compositions.inFlight -= 1;
        }
      }) as typeof execute;

      const hub = app6.realtimeHub;
      const subscribePublic = hub.subscribePublic;
      hub.subscribePublic = (id, fn) => {
        hubReleases.taken += 1;
        const off = subscribePublic(id, fn);
        let once = false;
        return () => {
          off();
          if (once) return;
          once = true;
          hubReleases.released += 1;
          for (const waiter of hubReleases.waiters.splice(0)) waiter();
        };
      };

      await app6.listen({ port: 0, host: '127.0.0.1' });
      port6 = (app6.server.address() as AddressInfo).port;
    });

    after(async () => {
      await app6.close().catch(() => undefined);
      for (const o of Object.values(orgs)) {
        if (o.id) await sql`delete from "organization" where "id" = ${o.id}`;
        if (o.userId) await sql`delete from "user" where "id" = ${o.userId}`;
      }
    });

    it('pushes the page after each public change, equal to what GET answers', async () => {
      const stream = await openPage(slugA);
      try {
        const first = pageOf(stream);
        assert.equal(first.id, (await getPage(slugA)).etag);

        const incidentId = await declareIncident(app6, orgs.a.cookie, {
          title: 'Visible is slow',
          affectedServices: [{ serviceId: visible, impact: 'minor' }],
        });
        let page = await converge(stream, slugA);
        assert.deepEqual(
          page.activeIncidents.map((i: { title: string }) => i.title),
          ['Visible is slow'],
        );

        await send(orgs.a, 'POST', `/incidents/${incidentId}/updates`, {
          message: 'Looking into it',
        });
        page = await converge(stream, slugA);
        assert.ok(
          JSON.stringify(page.activeIncidents).includes('Looking into it'),
        );

        await transitionIncident(app6, orgs.a.cookie, incidentId, 'resolved');
        page = await converge(stream, slugA);
        assert.deepEqual(page.activeIncidents, []);

        await scheduleMaintenance(app6, orgs.a.cookie, {
          title: 'Planned work',
          affectedServiceIds: [visible],
        });
        page = await converge(stream, slugA);
        assert.deepEqual(
          page.maintenance.map((w: { status: string }) => w.status),
          ['scheduled'],
        );

        const windowId = await withTenantTransaction(
          orgs.a.id,
          async ({ sql: tx }) => {
            const rows = await tx<{ id: string }[]>`
              insert into maintenance (
                org_id, title, status, scheduled_start_at, scheduled_end_at
              ) values (
                ${orgs.a.id}, 'Due work', 'scheduled',
                ${new Date(Date.now() - 60_000)}, ${new Date(Date.now() + 3_600_000)}
              ) returning id
            `;
            await tx`
              insert into maintenance_services (org_id, maintenance_id, service_id)
              values (${orgs.a.id}, ${rows[0].id}, ${visible})
            `;
            return rows[0].id;
          },
        );
        await transitionDueMaintenance(app6, orgs.a.id);
        page = await converge(stream, slugA);
        assert.ok(
          page.maintenance.some(
            (w: { id: string; status: string }) =>
              w.id === windowId && w.status === 'in_progress',
          ),
        );

        await send(orgs.a, 'PUT', `/services/${visible}/status-override`, {
          status: 'major_outage',
        });
        page = await converge(stream, slugA);
        const statuses = page.groups.flatMap((g) => g.services);
        assert.equal(
          statuses.find((s) => s.name === 'Visible')?.status,
          'major_outage',
        );
        await send(orgs.a, 'DELETE', `/services/${visible}/status-override`);
        await converge(stream, slugA);

        assertFramesTagged(stream);
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('sends no frame for a draft or a private incident', async () => {
      const stream = await openPage(slugA);
      try {
        const before = stream.received.length;

        const draftId = await draftOn(visible);
        await noFrameSince(stream, before, orgs.a.id);
        await send(orgs.a, 'PATCH', `/incidents/${draftId}`, {
          title: 'Edited draft',
        });
        await noFrameSince(stream, before, orgs.a.id);
        await send(orgs.a, 'POST', `/incidents/${draftId}/updates`, {
          message: 'Draft note',
        });
        await noFrameSince(stream, before, orgs.a.id);
        await transitionIncident(app6, orgs.a.cookie, draftId, 'resolved');
        await noFrameSince(stream, before, orgs.a.id);

        await declareIncident(app6, orgs.a.cookie, {
          title: 'Private only',
          impact: 'critical',
          affectedServices: [{ serviceId: hidden, impact: 'critical' }],
        });
        await noFrameSince(stream, before, orgs.a.id);

        // The next public change is the next frame.
        await updateService(app6, orgs.a.cookie, visible, {
          name: 'Visible 2',
        });
        // Counted from before the hidden changes, so a frame any of them sent
        // late is caught here: it would arrive ahead of this one.
        const page = await converge(stream, slugA);
        assert.equal(stream.received.length, before + 1);
        assert.ok(JSON.stringify(page).includes('Visible 2'));
        assert.ok(!JSON.stringify(page).includes('Private only'));
        assertFramesTagged(stream);
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('sends no frame for a manual override on a private service', async () => {
      const stream = await openPage(slugA);
      try {
        const before = stream.received.length;
        const secret = await createService(app6, orgs.a.cookie, {
          name: 'Secret',
          isPublic: false,
        });
        await settleOrg(orgs.a.id);
        compositions.count = 0;

        // The gate (Constraint 11): the override event is admin-only, but the
        // recomputation it causes emits a public `service.status_changed`
        // whose page is unchanged, so only the ETag comparison keeps it quiet.
        await send(orgs.a, 'PUT', `/services/${secret}/status-override`, {
          status: 'major_outage',
        });
        await settleOrg(orgs.a.id);
        assert.ok(
          compositions.count >= 1,
          'the recomputation asked for a page',
        );
        assert.equal(stream.received.length, before, 'and no frame was sent');

        await updateService(app6, orgs.a.cookie, visible, {
          name: 'Visible 3',
        });
        const page = await converge(stream, slugA);
        assert.equal(stream.received.length, before + 1);
        assert.ok(JSON.stringify(page).includes('Visible 3'));
        assert.ok(!JSON.stringify(page).includes(secret));
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('drops an incident or window, and its service id, when its service goes private, is archived or the window is deleted', async () => {
      const stream = await openPage(slugA);
      try {
        const doomed = await createService(app6, orgs.a.cookie, {
          name: 'Doomed',
        });
        const gone = await createService(app6, orgs.a.cookie, { name: 'Gone' });
        await declareIncident(app6, orgs.a.cookie, {
          title: 'Doomed incident',
          affectedServices: [{ serviceId: doomed, impact: 'minor' }],
        });
        await scheduleMaintenance(app6, orgs.a.cookie, {
          title: 'Gone window',
          affectedServiceIds: [gone],
        });
        const deleted = await scheduleMaintenance(app6, orgs.a.cookie, {
          title: 'Deleted window',
          affectedServiceIds: [visible],
        });
        let page = await converge(stream, slugA);
        assert.ok(JSON.stringify(page).includes('Doomed incident'));
        assert.ok(JSON.stringify(page).includes('Gone window'));
        assert.ok(JSON.stringify(page).includes('Deleted window'));

        await updateService(app6, orgs.a.cookie, doomed, { isPublic: false });
        page = await converge(stream, slugA);
        assert.ok(!JSON.stringify(page).includes('Doomed incident'));
        assert.ok(!JSON.stringify(page).includes(doomed));

        await archiveService(app6, orgs.a.cookie, gone);
        page = await converge(stream, slugA);
        assert.ok(!JSON.stringify(page).includes('Gone window'));
        assert.ok(!JSON.stringify(page).includes(gone));

        await send(orgs.a, 'DELETE', `/maintenance/${deleted}`);
        page = await converge(stream, slugA);
        assert.ok(!JSON.stringify(page).includes('Deleted window'));
        assertFramesTagged(stream);
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('lists a confirmed draft with its timeline opening at the confirmation entry', async () => {
      const stream = await openPage(slugA);
      try {
        const draftId = await draftOn(visible);
        await send(orgs.a, 'POST', `/incidents/${draftId}/updates`, {
          message: 'Private draft note',
        });
        await transitionIncident(app6, orgs.a.cookie, draftId, 'investigating');
        const page = await converge(stream, slugA);
        const listed = page.activeIncidents.find(
          (i: { id: string }) => i.id === draftId,
        );
        assert.ok(listed, 'the confirmed draft is listed');
        assert.equal(listed.updates[0].status, 'investigating');
        assert.ok(
          listed.updates.every((u: { status: string }) => u.status !== 'draft'),
        );
        assert.ok(!JSON.stringify(page).includes('Private draft note'));
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('composes nothing for admin-only events', async () => {
      const stream = await openPage(slugA);
      try {
        const before = stream.received.length;
        // The positive control: the admin channel hears both events.
        const admin = subscribeForOrg(app6.realtimeHub, orgs.a.id);
        await draftOn(visible);
        app6.eventBus.emit(
          monitorThresholdBreachedEvent({
            orgId: orgs.a.id,
            monitorId: randomUUID(),
            serviceId: visible,
            monitorName: 'noise',
            failureEpisode: 99,
          }),
        );
        await admin.settle(app6);
        await quiet();
        const heard = admin.admin.flatMap((signal) =>
          signal.kind === 'event' ? [signal.event.eventName] : [],
        );
        admin.close();
        assert.ok(heard.includes('incident.draft_created'), heard.join());
        assert.ok(heard.includes('monitor.threshold_breached'), heard.join());
        assert.equal(compositions.count, 0);
        assert.equal(stream.received.length, before);
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('coalesces a burst into two compositions and sends the final page once', async () => {
      const one = await openPage(slugA);
      const two = await openPage(slugA);
      try {
        const release = hold();
        for (const name of ['Burst 1', 'Burst 2', 'Burst 3']) {
          await updateService(app6, orgs.a.cookie, visible, { name });
        }
        await app6.eventBus.drain();
        const sub = subscribeForOrg(app6.realtimeHub, orgs.a.id);
        await sub.settle(app6);
        sub.close();
        assert.equal(compositions.count, 1, 'one in flight, held');
        release();
        await quiet();

        assert.equal(compositions.count, 2, 'one in flight plus one queued');
        for (const stream of [one, two]) {
          assert.equal(
            stream.received.length,
            2,
            'the opening and the final page',
          );
          assert.ok(JSON.stringify(pageOf(stream).page).includes('Burst 3'));
        }
        assertFramesTagged(one);
      } finally {
        one.close();
        two.close();
        await releasedAll();
      }
    });

    it('composes nothing for an org whose streams have all closed', async () => {
      const stream = await openPage(slugB);
      stream.close();
      await releasedAll();
      const [bee] = await withTenantTransaction(
        orgs.b.id,
        ({ sql: tx }) => tx<{ id: string }[]>`select id from services limit 1`,
      );
      await updateService(app6, orgs.b.cookie, bee.id, { name: 'Bee 2' });
      await settleOrg(orgs.b.id);
      assert.equal(compositions.count, 0);
    });

    it('composes only the org whose public change arrived, with streams open on two', async () => {
      const a = await openPage(slugA);
      const b = await openPage(slugB);
      try {
        const beforeB = b.received.length;
        await updateService(app6, orgs.a.cookie, visible, {
          name: 'Visible A',
        });
        await converge(a, slugA);
        await settleOrg(orgs.a.id);
        await settleOrg(orgs.b.id);

        assert.ok((compositions.bySlug.get(slugA) ?? 0) >= 1);
        assert.equal(compositions.bySlug.get(slugB), undefined);
        assert.equal(b.received.length, beforeB);
      } finally {
        a.close();
        b.close();
        await releasedAll();
      }
    });

    it('recomposes each org on resync and sends only the page that changed', async () => {
      const a = await openPage(slugA);
      const b = await openPage(slugB);
      try {
        const beforeA = a.received.length;
        const beforeB = b.received.length;
        await withTenantTransaction(
          orgs.b.id,
          ({ sql: tx }) =>
            tx`update services set name = 'Changed silently' where org_id = ${orgs.b.id}`,
        );
        app6.realtimeHub.resync();
        await quiet();
        await converge(b, slugB);

        assert.equal(compositions.count, 2, 'one composition per org');
        assert.equal(a.received.length, beforeA);
        assert.equal(b.received.length, beforeB + 1);
        assert.ok(JSON.stringify(pageOf(b).page).includes('Changed silently'));
      } finally {
        a.close();
        b.close();
        await releasedAll();
      }
    });

    it('logs a failed composition, keeps the stream, and pushes on the next event', async () => {
      const stream = await openPage(slugA);
      try {
        const before = stream.received.length;
        compositions.failNext = true;
        await updateService(app6, orgs.a.cookie, visible, { name: 'Failing' });
        await settleOrg(orgs.a.id);
        assert.equal(
          compositions.failNext,
          false,
          'the composition ran and failed',
        );
        assert.equal(stream.received.length, before);

        await updateService(app6, orgs.a.cookie, visible, {
          name: 'Recovered',
        });
        const page = await converge(stream, slugA);
        assert.ok(JSON.stringify(page).includes('Recovered'));
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    it('ends the streams of an org whose page is gone', async () => {
      const stream = await openPage(slugC);
      try {
        await sql`update "organization" set "slug" = ${`${slugC}-renamed`} where "id" = ${orgs.c.id}`;
        await notifyRaw(
          JSON.stringify({
            eventName: 'service.updated',
            orgId: orgs.c.id,
            aggregateType: 'service',
            aggregateId: randomUUID(),
            occurredAt: new Date().toISOString(),
            version: 1,
          }),
        );
        assert.equal(
          await withTimeout(stream.ended, 'the stream to end'),
          true,
        );
      } finally {
        stream.close();
        await releasedAll();
      }
    });

    // Last in this block: closes app6.
    it('app.close() waits for a composition in flight', async () => {
      const stream = await openPage(slugA);
      const release = hold();
      await updateService(app6, orgs.a.cookie, visible, { name: 'Closing' });
      await withTimeout(
        new Promise<void>((resolve) => {
          const check = () =>
            compositions.inFlight > 0 ? resolve() : setImmediate(check);
          check();
        }),
        'a composition in flight',
      );

      let settled = false;
      const closing = app6.close().then(() => {
        settled = true;
      });
      for (let n = 0; n < 5; n += 1) await tick();
      assert.equal(settled, false, 'close is waiting on the composition');

      release();
      await withTimeout(closing, 'app.close()', 5_000);
      assert.equal(compositions.inFlight, 0);
      stream.close();
    });
  });

  // Last: closes the file's app.
  it('ends every stream and gives back every subscription when the app closes', async () => {
    // Every earlier stream has been closed; wait until each is given back.
    await released(subscriptions.taken);
    const releasedBefore = subscriptions.released;
    const takenBefore = subscriptions.taken;
    const streams = [
      await open(`/status/${tag}/events`),
      await open(`/status/${tag}/events`, { localAddress: '127.0.0.2' }),
    ];
    for (const stream of streams) {
      assert.equal(stream.status, 200);
      await stream.nextFrame();
    }
    assert.equal(subscriptions.taken, takenBefore + 2);

    // The clients hold their connections open; closing must not wait on them.
    await withTimeout(app.close(), 'app.close() with streams open', 5_000);

    for (const stream of streams) {
      assert.equal(await withTimeout(stream.ended, 'the stream end'), true);
    }
    assert.equal(subscriptions.released, releasedBefore + 2);
    assert.equal(subscriptions.released, subscriptions.taken);
  });
});
