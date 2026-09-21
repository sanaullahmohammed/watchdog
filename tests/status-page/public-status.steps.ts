import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';
import type { ICustomWorld } from '../support/custom-world';

const hour = 60 * 60 * 1000;

type PublicPage = {
  overallStatus: string;
  groups: { services: { name: string; status: string }[] }[];
  activeIncidents: { title: string }[];
  maintenance: { title: string; status: string }[];
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
  'it does not mention {string}',
  function (this: ICustomWorld, text: string) {
    assert.ok(!this.context.body.includes(text), `${text} reached the page`);
  },
);

Then(
  "it does not mention the organization's slug",
  function (this: ICustomWorld) {
    // The miss must not become a way to learn which organizations exist.
    assert.ok(!this.context.body.includes(`"${this.context.slug}"`));
  },
);
