import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  openSubscription,
  type SubscriptionClient,
  type WsClose,
  type WsMessage,
} from '@/shared/testing/graphql';

/**
 * Story 4.9: a change the worker makes reaches a client of the separate api
 * process, over the LISTEN/NOTIFY backplane (FR16, ARCHITECTURE section 9).
 *
 * Black-box. It runs against the built image's `api` and `worker`, started by
 * `docker compose up --wait` as the `watchdog-backplane` project with
 * `docker-compose.backplane.yml` (see that file for the commands). It talks to
 * the api over HTTP and WebSocket only, and to the worker only by stopping and
 * starting its container. It loads nothing from `src/config` and opens no
 * pool: the database it would reach is not this stack's.
 */

const PASSWORD = 'correct-horse-battery-staple';
const TARGET_URL = 'http://backplane-target/';
const INTERVAL_SECONDS = 30;
const DOCKER_STEP_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
const OPEN_WAIT_MS = 10_000;

/** How long the liveness step listens before touching the service again. */
const LIVENESS_POKE_MS = 1_000;
const WORKER_STARTUP_MS = 15_000;
const SLACK_MS = 15_000;
/**
 * How long the worker stays stopped while nothing may happen. Three of the
 * stack's 1 s worker intervals would prove nothing about a check loop that
 * wrongly ran in the api: it would tick at the application default,
 * WORKER_MONITOR_INTERVAL_MS = 10 s, and could first fire after the window.
 * So the window outlasts that default by a second.
 */
const DEFAULT_MONITOR_INTERVAL_MS = 10_000;
const QUIET_WINDOW_MS = DEFAULT_MONITOR_INTERVAL_MS + 1_000;

const REPO_ROOT = resolve(__dirname, '../..');
/** Fixed here, so the test can never stop the dev stack's worker. */
const COMPOSE_ENV = {
  ...process.env,
  COMPOSE_PROJECT_NAME: 'watchdog-backplane',
  COMPOSE_FILE: 'docker-compose.yml:docker-compose.backplane.yml',
  COMPOSE_PROFILES: 'app,backplane',
};

const SUBSCRIPTION = `subscription {
  organizationEvents { eventName aggregateType aggregateId occurredAt }
}`;

const run = promisify(execFile);

async function compose(args: string[], timeoutMs = DOCKER_STEP_MS) {
  const what = `docker compose ${args.join(' ')}`;
  try {
    const { stdout } = await run('docker', ['compose', ...args], {
      cwd: REPO_ROOT,
      env: COMPOSE_ENV,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { killed?: boolean; stderr?: string };
    throw new Error(
      failure.killed
        ? `${what} did not finish within ${timeoutMs / 1000} s`
        : `${what} failed: ${failure.stderr ?? String(error)}`,
    );
  }
}

const failureThreshold = (() => {
  const raw = process.env.COMPOSE_TEST_FAILURE_THRESHOLD ?? '1';
  const value = Number(raw);
  assert.ok(
    Number.isInteger(value) && value >= 1 && value <= 20,
    `COMPOSE_TEST_FAILURE_THRESHOLD must be an integer from 1 to 20, not ${raw}`,
  );
  return value;
})();

const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

// ---------------------------------------------------------------------------
// Compose configuration

type ComposeService = {
  environment?: Record<string, string | null>;
  ports?: { host_ip?: string; published?: string; target: number }[];
  networks?: Record<string, { ipv4_address?: string } | null>;
};
type ComposeConfig = { services: Record<string, ComposeService> };

/** Read from `docker compose config` in `before`, never repeated here. */
const stack = {
  config: { services: {} } as ComposeConfig,
  /** The api's published address, unless COMPOSE_API_URL overrides it. */
  apiUrl: '',
  /** The stack's `BETTER_AUTH_URL`, which Better Auth requires as `Origin`. */
  origin: '',
  workerIntervalMs: 0,
};

// ---------------------------------------------------------------------------
// HTTP

/** Each cookie's name=value pair, from `getSetCookie()`, never `forEach`. */
function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function call<T>(
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: object } = {},
): Promise<{ response: Response; json: T }> {
  const headers: Record<string, string> = { origin: stack.origin };
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${stack.apiUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return { response, json: (text ? JSON.parse(text) : null) as T };
}

type Monitor = { id: string; lastCheckedAt: string | null };

async function lastCheckedAt(cookie: string, serviceId: string, id: string) {
  const { json } = await call<Monitor[]>(
    'GET',
    `/api/v1/services/${serviceId}/monitors`,
    { cookie },
  );
  const monitor = json.find((candidate) => candidate.id === id);
  assert.ok(monitor, `monitor ${id} is not listed`);
  return monitor.lastCheckedAt;
}

// ---------------------------------------------------------------------------
// The public stream, read over a real socket, as
// tests/status-page/public-status-stream.steps.ts reads it.

type StreamPage = {
  groups: { services: { name: string; status: string }[] }[];
};

type Held = {
  abort: AbortController;
  frames: { id: string; page: StreamPage }[];
  /** What stopped the reader, its own end included, other than our abort. */
  failure?: unknown;
  arrived: Array<() => void>;
};

/** Long-lived, so it has no fetch timeout; `after` aborts it. */
async function hold(slug: string): Promise<Held> {
  const held: Held = { abort: new AbortController(), frames: [], arrived: [] };
  const response = await fetch(`${stack.apiUrl}/status/${slug}/events`, {
    signal: held.abort.signal,
  });
  assert.equal(response.status, 200, `the stream for ${slug} did not open`);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const fail = (failure: unknown) => {
    if (held.abort.signal.aborted) return;
    held.failure = failure;
    for (const wake of held.arrived.splice(0)) wake();
  };
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          fail(new Error('the public stream ended'));
          return;
        }
        buffer += value;
        for (
          let at = buffer.indexOf('\n\n');
          at >= 0;
          at = buffer.indexOf('\n\n')
        ) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const id = /^id: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (id === undefined || data === undefined) continue; // a heartbeat
          held.frames.push({ id, page: JSON.parse(data) });
          for (const wake of held.arrived.splice(0)) wake();
        }
      }
    } catch (error) {
      fail(error);
    }
  })();
  return held;
}

/**
 * True when another frame arrives; false once `deadline` passes or the
 * stream has failed, which `held.failure` then names.
 */
function nextArrival(held: Held, deadline: number): Promise<boolean> {
  if (held.failure) return Promise.resolve(false);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    new Promise<boolean>((resolve) =>
      held.arrived.push(() => resolve(!held.failure)),
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const statusIn = (page: StreamPage, name: string) =>
  page.groups
    .flatMap((group) => group.services)
    .find((service) => service.name === name)?.status;

/** The first frame from index `from` that `matches`, if one arrives. */
async function awaitFrame(
  held: Held,
  from: number,
  matches: (page: StreamPage) => boolean,
  deadline: number,
) {
  for (let read = from; ; ) {
    for (; read < held.frames.length; read += 1) {
      if (matches(held.frames[read].page)) return held.frames[read];
    }
    if (Date.now() >= deadline) return undefined;
    if (!(await nextArrival(held, deadline))) return undefined;
  }
}

const streamTrouble = (held: Held) =>
  held.failure ? ` (the public stream failed: ${String(held.failure)})` : '';

// ---------------------------------------------------------------------------
// The admin subscription

type Signal = {
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
};

function signalOf(message: WsMessage, id: string): Signal {
  assert.equal(message.type, 'next', JSON.stringify(message));
  assert.equal(message.id, id);
  const event = (
    message.payload as { data?: { organizationEvents?: Signal } } | undefined
  )?.data?.organizationEvents;
  assert.ok(event, JSON.stringify(message));
  return event;
}

type Received =
  | { message: WsMessage }
  | { closed: WsClose }
  | { timedOut: true };

/** The next message, raced against the socket closing. */
function receive(
  client: SubscriptionClient,
  timeoutMs: number,
): Promise<Received> {
  return Promise.race([
    client.next(timeoutMs).then(
      (message): Received => ({ message }),
      (): Received => ({ timedOut: true }),
    ),
    client.closed.then((closed): Received => ({ closed })),
  ]);
}

const closedMessage = ({ code, reason }: WsClose) =>
  `the subscription closed with code ${code}${reason ? ` (${reason})` : ''}`;

/** Every message already received and not yet read. */
async function readUnread(client: SubscriptionClient, id: string) {
  const signals: Signal[] = [];
  for (;;) {
    const received = await receive(client, 1);
    if ('closed' in received) assert.fail(closedMessage(received.closed));
    if ('timedOut' in received) return signals;
    signals.push(signalOf(received.message, id));
  }
}

/**
 * Reads signals until every one `wanted` names has arrived, the socket closes
 * or `deadline` passes. `found` holds what arrived, by key.
 */
async function awaitSignals(
  client: SubscriptionClient,
  id: string,
  wanted: Record<string, (signal: Signal) => boolean>,
  deadline: number,
) {
  const seen: Signal[] = [];
  const found: Record<string, Signal> = {};
  let closed: WsClose | undefined;
  while (Object.keys(found).length < Object.keys(wanted).length) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const received = await receive(client, left);
    if ('closed' in received) {
      closed = received.closed;
      break;
    }
    if ('timedOut' in received) break;
    const signal = signalOf(received.message, id);
    seen.push(signal);
    for (const [key, matches] of Object.entries(wanted)) {
      if (!found[key] && matches(signal)) found[key] = signal;
    }
  }
  return { found, seen, closed };
}

const isMonitorOrIncident = (signal: Signal) =>
  /^(monitor|incident)\./.test(signal.eventName);

// ---------------------------------------------------------------------------

describe('worker events reach api clients under Compose (story 4.9)', () => {
  let workerStopped = false;
  let held: Held | undefined;
  let client: SubscriptionClient | undefined;

  before(async () => {
    stack.config = JSON.parse(
      await compose(['config', '--format', 'json']),
    ) as ComposeConfig;
    const { api, worker } = stack.config.services;

    stack.workerIntervalMs = Number(
      worker?.environment?.WORKER_MONITOR_INTERVAL_MS,
    );
    assert.ok(
      Number.isInteger(stack.workerIntervalMs) &&
        stack.workerIntervalMs >= 1000,
      `worker WORKER_MONITOR_INTERVAL_MS must be an integer of at least 1000, not ${stack.workerIntervalMs}`,
    );

    const origin = api?.environment?.BETTER_AUTH_URL;
    assert.ok(origin, 'api has no BETTER_AUTH_URL to send as Origin');
    stack.origin = origin;

    const published = api?.ports?.[0];
    assert.ok(
      published?.host_ip && published.published,
      `api publishes no host address: ${JSON.stringify(api?.ports)}`,
    );
    stack.apiUrl =
      process.env.COMPOSE_API_URL ??
      `http://${published.host_ip}:${published.published}`;
  });

  after(async () => {
    held?.abort.abort();
    await client?.close().catch(() => undefined);
    // Leave the stack as it was found, even when the test failed mid-window.
    if (workerStopped) await compose(['start', 'worker']);
  });

  it('allows only the target, publishes only the api, and joins both networks', () => {
    const { services } = stack.config;
    const target = services['backplane-target'];
    assert.deepEqual(
      Object.keys(target?.networks ?? {}),
      ['backplane'],
      'backplane-target must be on backplane only',
    );
    const targetAddress = target?.networks?.backplane?.ipv4_address;
    assert.ok(targetAddress, 'backplane-target has no fixed backplane address');

    for (const name of ['api', 'worker']) {
      assert.equal(
        services[name]?.environment?.MONITOR_ALLOWED_CIDRS,
        `${targetAddress}/32`,
        `${name} must allow exactly the target`,
      );
      assert.deepEqual(
        Object.keys(services[name]?.networks ?? {}).sort(),
        ['backplane', 'default'],
        `${name} must be on both default and backplane`,
      );
    }

    const published = Object.entries(services)
      .filter(([, service]) => (service.ports ?? []).length > 0)
      .map(([name]) => name);
    assert.deepEqual(published, ['api'], 'only the api publishes a port');
    for (const port of services.api.ports ?? []) {
      assert.equal(port.host_ip, '127.0.0.1', JSON.stringify(port));
    }
  });

  it("pushes the worker's breach to the public stream and the admin subscription", async () => {
    // 1. An operator with an organization of their own.
    const label = `backplane-${randomBytes(4).toString('hex')}`;
    const signUp = await call('POST', '/api/auth/sign-up/email', {
      body: {
        email: `${label}@example.test`,
        password: PASSWORD,
        name: label,
      },
    });
    const cookie = cookieFrom(signUp.response);
    assert.ok(cookie, 'sign-up set no cookie');
    await call('POST', '/api/auth/organization/create', {
      cookie,
      body: { name: `${label} Display Name`, slug: label },
    });

    // 2. Both channels open, before there is anything to send them.
    held = await hold(label);
    const opening = await awaitFrame(
      held,
      0,
      () => true,
      Date.now() + OPEN_WAIT_MS,
    );
    assert.ok(opening, `the stream sent no opening page${streamTrouble(held)}`);

    client = await openSubscription(stack.apiUrl, {
      cookie,
      origin: stack.origin,
    });
    const subscriptionId = client.subscribe(SUBSCRIPTION);

    // 3. A public service, which proves both channels live: the subscription
    // hears service.created and the stream pushes a page listing it.
    const serviceName = 'Backplane API';
    const {
      json: { id: serviceId },
    } = await call<{ id: string }>('POST', '/api/v1/services', {
      cookie,
      body: { name: serviceName, slug: `${label}-api`, isPublic: true },
    });
    const liveBy = Date.now() + OPEN_WAIT_MS;
    // The subscribe has no acknowledgement, and the api resolves its session
    // before joining the hub, so service.created can be published before the
    // subscription hears anything. Until it hears this service's event, the
    // service is touched again each second (service.updated, also bridged).
    const heardService = (signal: Signal) =>
      (signal.eventName === 'service.created' ||
        signal.eventName === 'service.updated') &&
      signal.aggregateId === serviceId;
    const subscription = client;
    const hearLive = async () => {
      const seen: Signal[] = [];
      for (let poke = 1; ; poke++) {
        const round = await awaitSignals(
          subscription,
          subscriptionId,
          { service: heardService },
          Math.min(liveBy, Date.now() + LIVENESS_POKE_MS),
        );
        seen.push(...round.seen);
        if (round.found.service || round.closed || Date.now() >= liveBy) {
          return { ...round, seen };
        }
        await call('PATCH', `/api/v1/services/${serviceId}`, {
          cookie,
          body: { description: `liveness check ${poke}` },
        });
      }
    };
    const [listed, live] = await Promise.all([
      awaitFrame(
        held,
        1,
        (page) => statusIn(page, serviceName) !== undefined,
        liveBy,
      ),
      hearLive(),
    ]);
    assert.ok(
      listed,
      `the stream pushed no page listing ${serviceName}${streamTrouble(held)}`,
    );
    assert.notEqual(statusIn(listed.page, serviceName), 'major_outage');
    assert.ok(
      live.found.service,
      live.closed
        ? closedMessage(live.closed)
        : `the subscription heard no service.created or service.updated for ${serviceId}; was sent ${JSON.stringify(live.seen)}`,
    );
    const framesBeforeStop = held.frames.length;

    // 4. The worker stops. Flagged first: if the bound fires, the daemon may
    // still stop it, and `after` must start it again.
    workerStopped = true;
    await compose(['stop', 'worker']);

    // 5. A monitor that fails every check.
    const {
      json: { id: monitorId },
    } = await call<{ id: string }>('POST', '/api/v1/monitors', {
      cookie,
      body: {
        serviceId,
        type: 'http',
        name: 'Backplane target',
        target: TARGET_URL,
        intervalSeconds: INTERVAL_SECONDS,
        failureThreshold,
      },
    });

    // 6. Nothing happens while the worker is stopped: the api runs no checks.
    const windowMs = Math.max(QUIET_WINDOW_MS, 3 * stack.workerIntervalMs);
    const quietUntil = Date.now() + windowMs;
    while (Date.now() < quietUntil) {
      await sleep(Math.min(stack.workerIntervalMs, quietUntil - Date.now()));
      assert.equal(
        await lastCheckedAt(cookie, serviceId, monitorId),
        null,
        'the monitor was checked with the worker stopped',
      );
    }
    const quiet = await readUnread(client, subscriptionId);
    assert.deepEqual(
      quiet.filter(isMonitorOrIncident),
      [],
      'a monitor or incident signal arrived with the worker stopped',
    );
    assert.equal(
      held.failure,
      undefined,
      `the public stream failed with the worker stopped: ${String(held.failure)}`,
    );
    assert.equal(
      held.frames.length,
      framesBeforeStop,
      'the stream pushed a page with the worker stopped',
    );

    // 7. The worker starts.
    await compose(['start', 'worker']);
    workerStopped = false;

    // 8. Both channels hear the worker, within the bound.
    const waitMs = process.env.COMPOSE_TEST_WAIT_MS
      ? Number(process.env.COMPOSE_TEST_WAIT_MS)
      : WORKER_STARTUP_MS +
        (failureThreshold - 1) * INTERVAL_SECONDS * 1000 +
        stack.workerIntervalMs +
        SLACK_MS;
    assert.ok(Number.isFinite(waitMs) && waitMs > 0, `wait bound ${waitMs}`);
    const deadline = Date.now() + waitMs;

    const [frame, signals] = await Promise.all([
      awaitFrame(
        held,
        framesBeforeStop,
        (page) => statusIn(page, serviceName) === 'major_outage',
        deadline,
      ),
      awaitSignals(
        client,
        subscriptionId,
        {
          breached: (signal) =>
            signal.eventName === 'monitor.threshold_breached' &&
            signal.aggregateId === monitorId,
          draft: (signal) => signal.eventName === 'incident.draft_created',
        },
        deadline,
      ),
    ]);

    const missing = [
      frame
        ? null
        : `no public page with ${serviceName} as major_outage${streamTrouble(held)}`,
      signals.found.breached
        ? null
        : `no monitor.threshold_breached for monitor ${monitorId}`,
      signals.found.draft ? null : 'no incident.draft_created',
      signals.closed ? closedMessage(signals.closed) : null,
    ].filter((entry): entry is string => entry !== null);
    assert.deepEqual(
      missing,
      [],
      `within ${waitMs} ms of starting the worker (threshold ${failureThreshold}): ` +
        `${missing.join('; ')}. Frames: ${JSON.stringify(
          held.frames.map(({ page }) => statusIn(page, serviceName)),
        )}. Signals: ${JSON.stringify(signals.seen)}`,
    );

    // The draft is this monitor's: on this service, from monitoring.
    const draftId = signals.found.draft?.aggregateId;
    const { json: draft } = await call<{
      status: string;
      source: string;
      affectedServices: { serviceId: string }[];
    }>('GET', `/api/v1/incidents/${draftId}`, { cookie });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.source, 'monitoring');
    assert.deepEqual(
      draft.affectedServices.map((affected) => affected.serviceId),
      [serviceId],
    );
    assert.notEqual(await lastCheckedAt(cookie, serviceId, monitorId), null);
  });
});
