import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { TEST_ORIGIN } from '@/shared/testing/tenant';
import type { ICustomWorld } from '../support/custom-world';

const hour = 60 * 60 * 1000;
const WAIT_MS = 10_000;

type StreamPage = {
  groups: { services: { name: string; status: string }[] }[];
  activeIncidents: { title: string }[];
  maintenance: { title: string }[];
};

type Held = {
  abort: AbortController;
  frames: { id: string; page: StreamPage; raw: string }[];
  /** What stopped the reader, other than the scenario's own abort. */
  failure?: unknown;
  /** Resolves each time another frame has arrived. */
  arrived: Array<() => void>;
};

/** Reads the stream over a real socket and keeps every frame it is sent. */
async function hold(world: ICustomWorld, slug: string): Promise<Held> {
  const held: Held = {
    abort: new AbortController(),
    frames: [],
    arrived: [],
  };
  const response = await fetch(`${world.baseUrl}/status/${slug}/events`, {
    signal: held.abort.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
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
          held.frames.push({ id, page: JSON.parse(data), raw: frame });
          for (const wake of held.arrived.splice(0)) wake();
        }
      }
    } catch (error) {
      // The scenario's own abort is not a failure; anything else, a parse
      // error included, fails the step that is waiting.
      if (!held.abort.signal.aborted) {
        held.failure = error;
        for (const wake of held.arrived.splice(0)) wake();
      }
    }
  })();
  return held;
}

function nextArrival(held: Held) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    new Promise<void>((resolve) => held.arrived.push(resolve)).then(() => {
      if (held.failure) throw held.failure;
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('the stream sent nothing in time')),
        WAIT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function admin(
  world: ICustomWorld,
  method: string,
  path: string,
  payload?: object,
) {
  const response = await world.server.inject({
    method: method as 'POST',
    url: `/api/v1${path}`,
    headers: { cookie: world.context.cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.ok(response.statusCode < 300, `${method} ${path}: ${response.body}`);
  return JSON.parse(response.body) as { id: string };
}

const held = (world: ICustomWorld): Held => world.context.held;

After(function (this: ICustomWorld) {
  this.context.held?.abort.abort();
});

Given(
  "a visitor holds the organization's status stream open",
  async function (this: ICustomWorld) {
    this.context.held = await hold(this, this.context.slug);
    if (held(this).frames.length === 0) await nextArrival(held(this));
    assert.equal(held(this).frames.length, 1, 'the stream opens with the page');
  },
);

When(
  'an operator declares the incident {string} affecting {string}',
  async function (this: ICustomWorld, title: string, service: string) {
    await admin(this, 'POST', '/incidents', {
      title,
      impact: 'minor',
      affectedServices: [
        { serviceId: this.context.services[service], impact: 'minor' },
      ],
    });
  },
);

When(
  'an operator schedules the window {string} affecting {string}',
  async function (this: ICustomWorld, title: string, service: string) {
    await admin(this, 'POST', '/maintenance', {
      title,
      scheduledStartAt: new Date(Date.now() + 24 * hour).toISOString(),
      scheduledEndAt: new Date(Date.now() + 25 * hour).toISOString(),
      affectedServiceIds: [this.context.services[service]],
    });
  },
);

When(
  'an operator overrides {string} to {string}',
  async function (this: ICustomWorld, service: string, status: string) {
    await admin(
      this,
      'PUT',
      `/services/${this.context.services[service]}/status-override`,
      { status },
    );
  },
);

Then(
  'the stream has been sent the status page as it is now',
  async function (this: ICustomWorld) {
    // The change settles (a recomputation can push a second page), so read
    // until the stream's latest page is the one the page answers.
    await this.server.eventBus.drain();
    for (;;) {
      const response = await fetch(
        `${this.baseUrl}/status/${this.context.slug}`,
      );
      const etag = response.headers.get('etag');
      if (held(this).failure) throw held(this).failure;
      const latest = held(this).frames.at(-1);
      if (latest && latest.id === etag) {
        assert.ok(
          !/^event:/m.test(latest.raw),
          'the frame is unnamed, for onmessage',
        );
        const { generatedAt: _, ...streamed } = latest.page as StreamPage & {
          generatedAt?: string;
        };
        const { generatedAt: __, ...served } =
          (await response.json()) as StreamPage & {
            generatedAt?: string;
          };
        assert.deepEqual(streamed, served);
        return;
      }
      await nextArrival(held(this));
    }
  },
);

Then(
  'that page lists the incident {string}',
  function (this: ICustomWorld, title: string) {
    const page = held(this).frames.at(-1)?.page;
    assert.deepEqual(
      page?.activeIncidents.map((incident) => incident.title),
      [title],
    );
  },
);

Then(
  'that page lists the window {string}',
  function (this: ICustomWorld, title: string) {
    const page = held(this).frames.at(-1)?.page;
    assert.deepEqual(
      page?.maintenance.map((window) => window.title),
      [title],
    );
  },
);

Then(
  'that page shows {string} as {string}',
  function (this: ICustomWorld, name: string, status: string) {
    const page = held(this).frames.at(-1)?.page;
    const service = page?.groups
      .flatMap((group) => group.services)
      .find((candidate) => candidate.name === name);
    assert.equal(service?.status, status);
  },
);
