import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { refreshUptimeRollupsCommand } from '@/modules/monitoring/commands/refresh-uptime-rollups/refresh-uptime-rollups.handler';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  createMonitor,
  insertCheckResult,
  utcToday,
} from '@/shared/testing/fixtures';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';
import type { ICustomWorld } from '../support/custom-world';

const hour = 60 * 60 * 1000;

type PublicPage = {
  overallStatus: string;
  groups: { services: { name: string; status: string }[] }[];
  activeIncidents: { title: string; affectedServiceIds: string[] }[];
  uptime: {
    windowDays: number;
    services: {
      serviceId: string;
      days: {
        date: string;
        uptimeRatio: number | null;
        worstStatus: string | null;
      }[];
    }[];
  };
  maintenance: {
    title: string;
    status: string;
    affectedServiceIds: string[];
  }[];
};

/**
 * Fixtures go through the admin API with the operator's session, the way an
 * operator builds a page. Never the seed: a scenario that leaned on the demo
 * organization would pass or fail with whatever the seed last contained.
 */
async function adminPost(world: ICustomWorld, path: string, payload = {}) {
  const response = await world.server.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { cookie: world.context.cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.ok(response.statusCode < 300, `POST ${path}: ${response.body}`);
  return JSON.parse(response.body) as { id: string };
}

async function createService(world: ICustomWorld, name: string, extra = {}) {
  const slug = `${world.context.slug}-${name.toLowerCase().replaceAll(/\W+/g, '-')}`;
  const { id } = await adminPost(world, '/services', { name, slug, ...extra });
  world.context.services[name] = id;
  return id;
}

/**
 * The visitor's side goes over a real socket with `fetch`, not `inject`: no
 * cookie jar, no origin, nothing the fixture's session could leak into.
 */
async function visit(world: ICustomWorld, slug: string) {
  // Recomputation is event-driven; let it land before anyone looks.
  await world.server.eventBus.drain();
  const response = await fetch(`${world.baseUrl}/status/${slug}`);
  world.context.status = response.status;
  world.context.body = await response.text();
}

function page(world: ICustomWorld) {
  return JSON.parse(world.context.body) as PublicPage;
}

Given(
  'an organization with a public status page',
  async function (this: ICustomWorld) {
    const slug = `e2e-${randomBytes(4).toString('hex')}`;
    const { cookie, userId, orgId } = await signUpWithOrg(this.server, slug);
    Object.assign(this.context, { slug, cookie, userId, orgId, services: {} });
  },
);

Given(
  'it has public services {string} and {string}',
  async function (this: ICustomWorld, first: string, second: string) {
    await createService(this, first);
    await createService(this, second);
  },
);

Given(
  'an active incident {string} affecting {string}',
  async function (this: ICustomWorld, title: string, service: string) {
    await adminPost(this, '/incidents', {
      title,
      impact: 'minor',
      affectedServices: [
        { serviceId: this.context.services[service], impact: 'minor' },
      ],
    });
  },
);

Given(
  'a scheduled maintenance window {string} affecting {string}',
  async function (this: ICustomWorld, title: string, service: string) {
    await adminPost(this, '/maintenance', {
      title,
      scheduledStartAt: new Date(Date.now() + 24 * hour).toISOString(),
      scheduledEndAt: new Date(Date.now() + 25 * hour).toISOString(),
      affectedServiceIds: [this.context.services[service]],
    });
  },
);

Given(
  'an active incident {string} affecting {string} and {string}',
  async function (this: ICustomWorld, title: string, a: string, b: string) {
    await adminPost(this, '/incidents', {
      title,
      impact: 'minor',
      affectedServices: [a, b].map((name) => ({
        serviceId: this.context.services[name],
        impact: 'minor',
      })),
    });
  },
);

Given(
  'a critical incident {string} affecting only {string}',
  async function (this: ICustomWorld, title: string, service: string) {
    // Critical, so that if it leaked it would take the banner to major_outage.
    await adminPost(this, '/incidents', {
      title,
      impact: 'critical',
      affectedServices: [
        { serviceId: this.context.services[service], impact: 'critical' },
      ],
    });
  },
);

Given(
  'a scheduled maintenance window {string} affecting {string} and {string}',
  async function (this: ICustomWorld, title: string, a: string, b: string) {
    await adminPost(this, '/maintenance', {
      title,
      scheduledStartAt: new Date(Date.now() + 26 * hour).toISOString(),
      scheduledEndAt: new Date(Date.now() + 27 * hour).toISOString(),
      affectedServiceIds: [a, b].map((name) => this.context.services[name]),
    });
  },
);

Given(
  'a private service {string}',
  async function (this: ICustomWorld, name: string) {
    await createService(this, name, { isPublic: false });
  },
);

Given(
  'an archived service {string}',
  async function (this: ICustomWorld, name: string) {
    const id = await createService(this, name);
    await adminPost(this, `/services/${id}/archive`);
  },
);

Given(
  'a draft incident {string} the monitor has not confirmed',
  async function (this: ICustomWorld, title: string) {
    // Written the way the monitor will write one. No API creates a draft:
    // they are monitor-born, and the monitor arrives in Epic 5.
    await withTenantTransaction(
      this.context.orgId,
      ({ sql }) => sql`
      insert into incidents (org_id, title, status, impact, source)
      values (${this.context.orgId}, ${title}, 'draft', 'major', 'monitoring')
    `,
    );
  },
);

When(
  "a visitor opens the organization's status page with no credentials",
  async function (this: ICustomWorld) {
    await visit(this, this.context.slug);
  },
);

When(
  'a visitor opens the status page for a slug no organization has',
  async function (this: ICustomWorld) {
    await visit(this, `${this.context.slug}-nobody`);
  },
);

Then('the page answers {int}', function (this: ICustomWorld, status: number) {
  assert.equal(this.context.status, status, this.context.body);
});

Then(
  'it names the public service {string} as {string}',
  function (this: ICustomWorld, name: string, status: string) {
    const service = page(this)
      .groups.flatMap((group) => group.services)
      .find((candidate) => candidate.name === name);
    assert.ok(service, `${name} is not on the page`);
    assert.equal(service.status, status);
  },
);

Then(
  'it shows the active incident {string}',
  function (this: ICustomWorld, title: string) {
    assert.deepEqual(
      page(this).activeIncidents.map((incident) => incident.title),
      [title],
    );
  },
);

Then(
  'it shows the scheduled window {string}',
  function (this: ICustomWorld, title: string) {
    assert.deepEqual(
      page(this).maintenance.map((window) => [window.title, window.status]),
      [[title, 'scheduled']],
    );
  },
);

Then(
  'the overall status is {string}',
  function (this: ICustomWorld, status: string) {
    assert.equal(page(this).overallStatus, status);
  },
);

Then(
  'it lists the incident {string} affecting only {string}',
  function (this: ICustomWorld, title: string, service: string) {
    const incident = page(this).activeIncidents.find((i) => i.title === title);
    assert.ok(incident, `${title} is not on the page`);
    assert.deepEqual(incident.affectedServiceIds, [
      this.context.services[service],
    ]);
  },
);

Then(
  'it lists the window {string} affecting only {string}',
  function (this: ICustomWorld, title: string, service: string) {
    const window = page(this).maintenance.find((w) => w.title === title);
    assert.ok(window, `${title} is not on the page`);
    assert.deepEqual(window.affectedServiceIds, [
      this.context.services[service],
    ]);
  },
);

Then(
  'it does not mention the id of {string}',
  function (this: ICustomWorld, name: string) {
    // Names alone would miss the ids an incident or window points at (R-1).
    const id = this.context.services[name];
    assert.ok(id, `no fixture service called ${name}`);
    assert.ok(!this.context.body.includes(id), `${name}'s id reached the page`);
  },
);

Then(
  'it does not mention {string}',
  function (this: ICustomWorld, text: string) {
    assert.ok(!this.context.body.includes(text), `${text} reached the page`);
  },
);

/** A miss body without its per-request correlation id. */
function missBody(body: string) {
  const { correlationId, ...rest } = JSON.parse(body);
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  return rest;
}

Then(
  'the body is the one answer every miss gets',
  function (this: ICustomWorld) {
    // The whole body. Checking only that the slug is absent passed with no
    // public route at all, because the router's own 404 never names it (VG-A).
    assert.deepEqual(missBody(this.context.body), {
      statusCode: 404,
      message: 'Status page not found',
      error: 'Not Found',
    });
  },
);

Then(
  'a slug over 100 characters gets that same answer',
  async function (this: ICustomWorld) {
    // Past the router's default param limit, where it once answered with its
    // own 404, echoing the path (R-8). Over a real socket, as a visitor sends it.
    const first = this.context.body;
    await visit(this, `${this.context.slug}-${'n'.repeat(150)}`);
    assert.equal(this.context.status, 404, this.context.body);
    assert.deepEqual(missBody(this.context.body), missBody(first));
  },
);

const DAY = 24 * hour;

Given(
  'a monitor for {string} recorded a failure yesterday',
  async function (this: ICustomWorld, service: string) {
    const serviceId = this.context.services[service];
    const monitorId = await createMonitor(
      this.server,
      this.context.cookie,
      serviceId,
    );
    const yesterday = new Date((await utcToday()).getTime() - DAY + 12 * hour);
    await insertCheckResult(this.context.orgId, {
      monitorId,
      serviceId,
      checkedAt: yesterday,
      status: 'failure',
    });
  },
);

Given('the uptime rollups were refreshed', async function (this: ICustomWorld) {
  await this.server.commandBus.execute(
    refreshUptimeRollupsCommand({ orgId: this.context.orgId }),
  );
});

function uptimeOf(world: ICustomWorld, name: string) {
  return page(world).uptime.services.find(
    (entry) => entry.serviceId === world.context.services[name],
  );
}

Then(
  'the uptime covers 90 days ending today for {string}',
  async function (this: ICustomWorld, name: string) {
    const entry = uptimeOf(this, name);
    assert.ok(entry, `${name} has no uptime`);
    assert.equal(page(this).uptime.windowDays, 90);
    assert.equal(entry.days.length, 90);
    assert.equal(
      entry.days.at(-1)?.date,
      (await utcToday()).toISOString().slice(0, 10),
    );
    assert.equal(
      entry.days[0].date,
      new Date((await utcToday()).getTime() - 89 * DAY)
        .toISOString()
        .slice(0, 10),
    );
  },
);

Then(
  'yesterday is {string} and {string} for {string}',
  async function (
    this: ICustomWorld,
    ratio: string,
    worst: string,
    name: string,
  ) {
    const yesterday = new Date((await utcToday()).getTime() - DAY)
      .toISOString()
      .slice(0, 10);
    const day = uptimeOf(this, name)?.days.find((d) => d.date === yesterday);
    assert.ok(day, `no ${yesterday} for ${name}`);
    assert.equal(day.uptimeRatio, Number(ratio));
    assert.equal(day.worstStatus, worst);
  },
);

Then(
  '{string} has no uptime but is on the page',
  function (this: ICustomWorld, name: string) {
    assert.equal(uptimeOf(this, name), undefined);
    const listed = page(this)
      .groups.flatMap((group) => group.services)
      .some((service) => service.name === name);
    assert.ok(listed, `${name} is not on the page`);
  },
);
