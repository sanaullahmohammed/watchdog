import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { PublicStatusPageResponseDto } from '@/modules/status-page/dtos/public-status-page.response.dto';
import { UPTIME_WINDOW_DAYS } from '@/modules/status-page/dtos/public-status-page.response.dto';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { signUpWithOrg, TEST_ORIGIN } from '@/shared/testing/tenant';

/** Story 3.3 — serve the public status payload. */

const tag = `pay-${randomBytes(4).toString('hex')}`;
const hour = 60 * 60 * 1000;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';
const slugA = `${tag}-a`;
const slugB = `${tag}-b`;

/**
 * One banner per page, so each banner case has an organization of its own. In
 * both, the only public service is operational: whatever the banner says
 * beyond that, only the incident rule can have put there.
 */
const banner = {
  unnamed: { slug: `${tag}-unnamed`, cookie: '', userId: '', orgId: '' },
  privateOnly: { slug: `${tag}-private`, cookie: '', userId: '', orgId: '' },
};

/** Fixture ids, named so an assertion reads as the thing rather than a uuid. */
const id: Record<string, string> = {};

async function post(cookie: string, path: string, payload: object = {}) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { cookie, origin: TEST_ORIGIN },
    payload,
  });
  assert.ok(response.statusCode < 300, `POST ${path}: ${response.body}`);
  return JSON.parse(response.body) as { id?: string };
}

async function createGroup(name: string, slug: string, displayOrder: number) {
  const body = await post(cookieA, '/service-groups', {
    name,
    slug,
    displayOrder,
  });
  return body.id as string;
}

async function createService(
  cookie: string,
  service: {
    name: string;
    slug: string;
    description?: string;
    displayOrder?: number;
    serviceGroupId?: string;
    isPublic?: boolean;
  },
) {
  const body = await post(cookie, '/services', service);
  return body.id as string;
}

/** Writes a status nothing would recompute, to prove the page reads it. */
function forceStatus(orgId: string, serviceId: string, status: string) {
  return withTenantTransaction(
    orgId,
    ({ sql: tx }) =>
      tx`update services set last_known_status = ${status} where id = ${serviceId}`,
  );
}

/** No cookie, no origin: the way anyone holding the link arrives. */
async function fetchPage(slug: string) {
  const response = await app.inject({ method: 'GET', url: `/status/${slug}` });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as PublicStatusPageResponseDto;
}

const PAGE_SELECTION = `
  organization { name slug }
  overallStatus
  generatedAt
  groups {
    id name displayOrder
    services { id name slug description status displayOrder }
  }
  activeIncidents {
    id title impact status startedAt affectedServiceIds
    updates { id status message createdAt }
  }
  maintenance {
    id title description status
    scheduledStartAt scheduledEndAt startedAt affectedServiceIds
  }
  uptime { windowDays services { serviceId days { date uptimeRatio } } }
`;

async function fetchPageOverGraphql(slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: {
      query: `query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { ${PAGE_SELECTION} } }`,
      variables: { slug },
    },
  });
  const body = JSON.parse(response.body) as {
    data: { publicStatusPage: PublicStatusPageResponseDto } | null;
    errors?: { message: string }[];
  };
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data?.publicStatusPage as PublicStatusPageResponseDto;
}

describe('Story 3.3: serve the public status payload', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, slugA));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(app, slugB));

    // Groups. Aardvark and Beta share a display order, so the name settles
    // them; Alpha sorts first by name and last by order.
    const aardvark = await createGroup('Aardvark', `${tag}-aardvark`, 1);
    const beta = await createGroup('Beta', `${tag}-beta`, 1);
    const alpha = await createGroup('Alpha', `${tag}-alpha`, 2);

    id.solo = await createService(cookieA, {
      name: 'Solo',
      slug: `${tag}-solo`,
      serviceGroupId: aardvark,
      displayOrder: 0,
    });
    // Inside Beta the same two rules apply to services: Aurora is first
    // alphabetically and last by display order, and Cobalt and Delta tie.
    id.aurora = await createService(cookieA, {
      name: 'Aurora',
      slug: `${tag}-aurora`,
      serviceGroupId: beta,
      displayOrder: 5,
    });
    id.cobalt = await createService(cookieA, {
      name: 'Cobalt',
      slug: `${tag}-cobalt`,
      serviceGroupId: beta,
      displayOrder: 0,
    });
    id.delta = await createService(cookieA, {
      name: 'Delta',
      slug: `${tag}-delta`,
      serviceGroupId: beta,
      displayOrder: 0,
      description: 'A service with something to say',
    });
    id.late = await createService(cookieA, {
      name: 'Late',
      slug: `${tag}-late`,
      serviceGroupId: alpha,
      displayOrder: 0,
    });
    id.unfiled = await createService(cookieA, {
      name: 'Unfiled',
      slug: `${tag}-unfiled`,
      displayOrder: 0,
    });

    id.hidden = await createService(cookieA, {
      name: 'Hidden',
      slug: `${tag}-hidden`,
      serviceGroupId: beta,
      isPublic: false,
    });
    // Archived only once the incident and window below name it: the way a
    // real one gets there, since nothing stops an operator archiving a
    // service an open incident still names.
    id.archived = await createService(cookieA, {
      name: 'Archived',
      slug: `${tag}-archived`,
      serviceGroupId: beta,
    });

    // Incidents. The older one carries impact `none` and names no service, so
    // it changes no status and this file's status assertions stay readable.
    id.olderIncident = (
      await post(cookieA, '/incidents', {
        title: 'Older, still open',
        impact: 'none',
        startedAt: new Date(Date.now() - 3 * hour).toISOString(),
        message: 'Watching a slow queue.',
      })
    ).id as string;
    id.activeIncident = (
      await post(cookieA, '/incidents', {
        title: 'Checkout is degraded',
        impact: 'minor',
        // Hidden and Archived ride along, so the exclusion checks below look
        // at affected-service ids as well as at the service list (R-1).
        affectedServices: [
          { serviceId: id.solo, impact: 'minor' },
          { serviceId: id.hidden, impact: 'minor' },
          { serviceId: id.archived, impact: 'minor' },
        ],
        message: 'We are looking into it.',
      })
    ).id as string;
    await post(cookieA, `/incidents/${id.activeIncident}/transition`, {
      status: 'identified',
      message: 'A bad deploy; rolling back.',
    });

    // Names only a private service, so the page leaves it off (R-2). Declared
    // last, it is the newest: were it listed, it would come first. Its
    // `critical` would also take the banner to major_outage, which the banner
    // test below rules out.
    id.privateIncident = (
      await post(cookieA, '/incidents', {
        title: 'Internal ledger rebuild',
        impact: 'critical',
        affectedServices: [{ serviceId: id.hidden, impact: 'critical' }],
      })
    ).id as string;

    id.resolvedIncident = (
      await post(cookieA, '/incidents', {
        title: 'Yesterday, and over',
        impact: 'minor',
      })
    ).id as string;
    await post(cookieA, `/incidents/${id.resolvedIncident}/transition`, {
      status: 'resolved',
    });

    // A monitor-born draft: nobody was ever told about it. Drafts arrive in
    // Epic 5, so it is written the way the monitor will.
    [{ id: id.draftIncident }] = await withTenantTransaction(
      orgAId,
      ({ sql: tx }) => tx<{ id: string }[]>`
        insert into incidents (org_id, title, status, impact, source)
        values (${orgAId}, 'Monitor noise', 'draft', 'major', 'monitoring')
        returning id
      `,
    );

    // Maintenance. The running window starts in the past so it sorts first.
    id.runningWindow = (
      await post(cookieA, '/maintenance', {
        title: 'Database failover',
        description: 'Brief interruptions while we fail over.',
        scheduledStartAt: new Date(Date.now() - hour).toISOString(),
        scheduledEndAt: new Date(Date.now() + hour).toISOString(),
        affectedServiceIds: [id.late],
      })
    ).id as string;
    // Started by hand rather than through the worker: this file is about what
    // the page shows, and the worker's own transition has its own suite.
    await withTenantTransaction(
      orgAId,
      ({ sql: tx }) => tx`
        update maintenance set status = 'in_progress', started_at = now()
        where id = ${id.runningWindow}
      `,
    );

    id.scheduledWindow = (
      await post(cookieA, '/maintenance', {
        title: 'Cache migration',
        scheduledStartAt: new Date(Date.now() + 2 * hour).toISOString(),
        scheduledEndAt: new Date(Date.now() + 3 * hour).toISOString(),
        affectedServiceIds: [id.cobalt, id.hidden, id.archived],
      })
    ).id as string;

    // Names only services the page does not show. It starts between the two
    // listed windows, so were it listed it would sit in the middle.
    id.privateWindow = (
      await post(cookieA, '/maintenance', {
        title: 'Private rack move',
        scheduledStartAt: new Date(Date.now() + 1.5 * hour).toISOString(),
        scheduledEndAt: new Date(Date.now() + 2.5 * hour).toISOString(),
        affectedServiceIds: [id.hidden, id.archived],
      })
    ).id as string;

    await post(cookieA, `/services/${id.archived}/archive`);

    id.completedWindow = (
      await post(cookieA, '/maintenance', {
        title: 'Last week, and done',
        scheduledStartAt: new Date(Date.now() + 4 * hour).toISOString(),
        scheduledEndAt: new Date(Date.now() + 5 * hour).toISOString(),
      })
    ).id as string;
    await post(cookieA, `/maintenance/${id.completedWindow}/complete`);

    // The neighbour, with one of everything.
    id.otherService = await createService(cookieB, {
      name: 'Their service',
      slug: `${tag}-theirs`,
    });
    id.otherIncident = (
      await post(cookieB, '/incidents', {
        title: 'Their incident',
        impact: 'critical',
        affectedServices: [{ serviceId: id.otherService, impact: 'critical' }],
      })
    ).id as string;
    id.otherWindow = (
      await post(cookieB, '/maintenance', {
        title: 'Their window',
        scheduledStartAt: new Date(Date.now() + hour).toISOString(),
        scheduledEndAt: new Date(Date.now() + 2 * hour).toISOString(),
      })
    ).id as string;

    for (const org of Object.values(banner)) {
      ({
        cookie: org.cookie,
        userId: org.userId,
        orgId: org.orgId,
      } = await signUpWithOrg(app, org.slug));
      await createService(org.cookie, {
        name: 'Front door',
        slug: `${org.slug}-front`,
      });
    }
    // No service named yet: blast radius is often unknown at first.
    id.unnamedIncident = (
      await post(banner.unnamed.cookie, '/incidents', {
        title: 'Something is wrong',
        impact: 'major',
      })
    ).id as string;
    const backOffice = await createService(banner.privateOnly.cookie, {
      name: 'Back office',
      slug: `${banner.privateOnly.slug}-back`,
      isPublic: false,
    });
    id.backOfficeIncident = (
      await post(banner.privateOnly.cookie, '/incidents', {
        title: 'Back office outage',
        impact: 'critical',
        affectedServices: [{ serviceId: backOffice, impact: 'critical' }],
      })
    ).id as string;

    // Last, and deliberately so: status recomputation is event-driven and
    // recomputes the whole organization, so anything written before the events
    // above have settled would be corrected back out from under the tests.
    await app.eventBus.drain();
    await forceStatus(orgAId, id.unfiled, 'partial_outage');
    await forceStatus(orgAId, id.hidden, 'major_outage');
  });

  after(async () => {
    const orgIds = [
      orgAId,
      orgBId,
      ...Object.values(banner).map((o) => o.orgId),
    ];
    const userIds = [
      userAId,
      userBId,
      ...Object.values(banner).map((o) => o.userId),
    ];
    await sql`delete from "organization" where "id" in ${sql(orgIds)}`;
    await sql`delete from "user" where "id" in ${sql(userIds)}`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('shows public, unarchived services only, in their groups and already ordered', async () => {
    const page = await fetchPage(slugA);

    assert.deepEqual(
      page.groups.map((group) => group.name),
      ['Aardvark', 'Beta', 'Alpha', null],
    );
    assert.deepEqual(
      page.groups.map((group) => group.services.map((service) => service.name)),
      [['Solo'], ['Cobalt', 'Delta', 'Aurora'], ['Late'], ['Unfiled']],
    );

    // Both rules are load-bearing here: Alpha and Aurora each sort first by
    // name and last by display order, so dropping either one moves them.
    const ungrouped = page.groups.at(-1);
    assert.deepEqual(
      {
        id: ungrouped?.id,
        name: ungrouped?.name,
        displayOrder: ungrouped?.displayOrder,
      },
      { id: null, name: null, displayOrder: null },
      'services in no group arrive in a group that is explicitly none',
    );

    const body = JSON.stringify(page);
    assert.ok(!body.includes(id.hidden), 'a non-public service stayed off');
    assert.ok(!body.includes(id.archived), 'an archived service stayed off');
  });

  it('carries each service as the admin API describes it', async () => {
    const page = await fetchPage(slugA);
    const delta = page.groups
      .flatMap((group) => group.services)
      .find((service) => service.id === id.delta);

    assert.deepEqual(delta, {
      id: id.delta,
      name: 'Delta',
      slug: `${tag}-delta`,
      description: 'A service with something to say',
      status: 'operational',
      displayOrder: 0,
    });
  });

  it('reads each status from last_known_status rather than recomputing it', async () => {
    const page = await fetchPage(slugA);
    const unfiled = page.groups
      .flatMap((group) => group.services)
      .find((service) => service.id === id.unfiled);

    // Nothing about Unfiled would recompute to partial_outage: no incident
    // names it, it has no override, no monitor and no maintenance window. The
    // value can only have been read, which is the point — a page that
    // recomputed would do it on every request.
    assert.equal(unfiled?.status, 'partial_outage');

    const solo = page.groups
      .flatMap((group) => group.services)
      .find((service) => service.id === id.solo);
    assert.equal(
      solo?.status,
      'degraded',
      'and a status the recomputation did write is shown as it stands',
    );
  });

  it('reduces the banner to the worst public status, which a private service never raises', async () => {
    const page = await fetchPage(slugA);

    // Hidden sits at major_outage and is not public. The worst status anyone
    // can see is Unfiled's partial_outage.
    assert.equal(page.overallStatus, 'partial_outage');
    assert.ok(
      !JSON.stringify(page).includes('major_outage'),
      'no private service reaches the page, banner included',
    );
  });

  it('shows active incidents newest first, each with its timeline oldest first', async () => {
    const page = await fetchPage(slugA);

    assert.deepEqual(
      page.activeIncidents.map((incident) => incident.id),
      [id.activeIncident, id.olderIncident],
    );

    const [current] = page.activeIncidents;
    assert.equal(current.status, 'identified');
    assert.equal(current.impact, 'minor');
    assert.deepEqual(current.affectedServiceIds, [id.solo]);
    assert.deepEqual(
      current.updates.map((update) => [update.status, update.message]),
      [
        ['investigating', 'We are looking into it.'],
        ['identified', 'A bad deploy; rolling back.'],
      ],
      'oldest to newest, so a renderer showing the latest reads the end',
    );
  });

  it('leaves off an incident or window that names only services the page does not show', async () => {
    const body = JSON.stringify(await fetchPage(slugA));

    for (const [what, value] of [
      ['the private incident', id.privateIncident],
      ['its title', 'Internal ledger rebuild'],
      ['the private window', id.privateWindow],
      ['its title', 'Private rack move'],
    ]) {
      assert.ok(!body.includes(value), `${what} stayed off the page`);
    }
  });

  it('lists an incident that names no service, and lets its impact raise the banner', async () => {
    const page = await fetchPage(banner.unnamed.slug);

    assert.deepEqual(
      page.activeIncidents.map((incident) => [
        incident.id,
        incident.affectedServiceIds,
      ]),
      [[id.unnamedIncident, []]],
    );
    // Front door is operational. The banner can only be partial_outage because
    // the listed `major` incident is folded in, by DOMAIN's impact mapping.
    assert.deepEqual(
      page.groups.flatMap((group) => group.services.map((s) => s.status)),
      ['operational'],
    );
    assert.equal(page.overallStatus, 'partial_outage');
  });

  it('keeps an incident naming only a private service off the banner too', async () => {
    const page = await fetchPage(banner.privateOnly.slug);

    assert.deepEqual(page.activeIncidents, []);
    // Back office sits at major_outage and its incident is critical. Neither
    // is listed, so neither may reach the banner.
    assert.equal(page.overallStatus, 'operational');
    assert.ok(!JSON.stringify(page).includes(id.backOfficeIncident));
  });

  it('shows neither a resolved incident nor a draft one', async () => {
    const body = JSON.stringify(await fetchPage(slugA));

    assert.ok(
      !body.includes(id.resolvedIncident),
      'a resolved incident is over',
    );
    // A draft describes an outage customers were never told about. Publishing
    // one would announce an incident the operator has not confirmed.
    assert.ok(!body.includes(id.draftIncident), 'a draft was never public');
  });

  it('shows scheduled and in-progress maintenance with the services it affects', async () => {
    const page = await fetchPage(slugA);

    assert.deepEqual(
      page.maintenance.map((window) => [window.id, window.status]),
      [
        [id.runningWindow, 'in_progress'],
        [id.scheduledWindow, 'scheduled'],
      ],
      'ordered by when each starts',
    );
    assert.deepEqual(page.maintenance[0].affectedServiceIds, [id.late]);
    assert.deepEqual(page.maintenance[1].affectedServiceIds, [id.cobalt]);
    assert.ok(page.maintenance[0].startedAt !== null, 'a running window began');
    assert.equal(page.maintenance[1].startedAt, null);
    assert.equal(
      page.maintenance[0].description,
      'Brief interruptions while we fail over.',
    );

    // The page describes what is happening rather than what has.
    assert.ok(!JSON.stringify(page).includes(id.completedWindow));
  });

  it('carries the uptime window in its final shape and explicitly empty', async () => {
    const page = await fetchPage(slugA);

    // Epic 5 fills this. Until then an integrator can tell "no data yet" from
    // "100% uptime", which a missing field would not have said.
    assert.deepEqual(page.uptime, {
      windowDays: UPTIME_WINDOW_DAYS,
      services: [],
    });
    assert.equal(UPTIME_WINDOW_DAYS, 90);
  });

  it('never carries another organization rows', async () => {
    const [a, b] = await Promise.all([fetchPage(slugA), fetchPage(slugB)]);
    const [bodyA, bodyB] = [JSON.stringify(a), JSON.stringify(b)];

    for (const theirs of [id.otherService, id.otherIncident, id.otherWindow]) {
      assert.ok(!bodyA.includes(theirs), 'their rows stayed on their page');
    }
    for (const ours of [id.solo, id.activeIncident, id.runningWindow]) {
      assert.ok(!bodyB.includes(ours), 'our rows stayed on ours');
    }

    // Every read runs under the organization the slug resolved to, so this is
    // RLS doing it rather than a where clause anyone could forget.
    assert.deepEqual(
      b.groups.flatMap((group) => group.services).map((service) => service.id),
      [id.otherService],
    );
    assert.deepEqual(
      b.activeIncidents.map((incident) => incident.id),
      [id.otherIncident],
    );
  });

  it('answers the same values over REST and GraphQL', async () => {
    const [rest, graphql] = await Promise.all([
      fetchPage(slugA),
      fetchPageOverGraphql(slugA),
    ]);

    // Composed a moment apart, so this is the one field that legitimately
    // differs; both surfaces are otherwise the same presenter over the same
    // reads, which is what keeps them from drifting.
    assert.ok(!Number.isNaN(Date.parse(rest.generatedAt)));
    assert.ok(!Number.isNaN(Date.parse(graphql.generatedAt)));
    assert.deepEqual(
      { ...graphql, generatedAt: '' },
      { ...rest, generatedAt: '' },
    );
  });
});
