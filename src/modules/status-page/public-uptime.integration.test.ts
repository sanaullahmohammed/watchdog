import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import publicStatusRepository from '@/modules/status-page/database/public-status.repository';
import type { PublicStatusPageResponseDto } from '@/modules/status-page/dtos/public-status-page.response.dto';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import {
  type TenantTransaction,
  withTenantTransaction,
} from '@/shared/db/tenant-transaction';
import type { UptimeDayStatus } from '@/shared/domain/status-inputs';
import {
  archiveService,
  createService,
  createServiceGroup,
  insertUptimeRollup,
  updateService,
  utcToday,
} from '@/shared/testing/fixtures';
import { gqlData } from '@/shared/testing/graphql';
import { signUpWithOrg } from '@/shared/testing/tenant';

/** Story 5.12 - the 90-day uptime in the public payload. */

const tag = `upt-${randomBytes(4).toString('hex')}`;
const DAY = 24 * 60 * 60 * 1000;

type Org = { slug: string; cookie: string; userId: string; orgId: string };

let app: FastifyInstance;
let today: Date;
const orgs: Org[] = [];

async function makeOrg(label: string): Promise<Org> {
  const slug = `${tag}-${label}`;
  const org = { slug, ...(await signUpWithOrg(app, slug)) };
  orgs.push(org);
  return org;
}

/** The UTC day `n` days before today, as `YYYY-MM-DD`. */
const dayText = (n: number) =>
  new Date(today.getTime() - n * DAY).toISOString().slice(0, 10);
const dayDate = (n: number) => new Date(today.getTime() - n * DAY);

const rollup = (
  org: Org,
  serviceId: string,
  n: number,
  uptimeRatio: number,
  worstStatus: UptimeDayStatus,
) =>
  insertUptimeRollup(org.orgId, {
    serviceId,
    day: dayDate(n),
    uptimeRatio,
    worstStatus,
  });

async function fetchPage(slug: string) {
  const response = await app.inject({ method: 'GET', url: `/status/${slug}` });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body) as PublicStatusPageResponseDto;
}

describe('Story 5.12: the 90-day uptime in the public payload', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    today = await utcToday();
  });

  after(async () => {
    if (orgs.length > 0) {
      await sql`delete from "organization" where "id" in ${sql(orgs.map((o) => o.orgId))}`;
      await sql`delete from "user" where "id" in ${sql(orgs.map((o) => o.userId))}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('fills exactly 90 UTC days, oldest first, with nulls where no row exists', async () => {
    const org = await makeOrg('fill');
    const s = await createService(app, org.cookie, { name: 'S' });
    await rollup(org, s, 0, 1, 'operational');
    await rollup(org, s, 5, 0.75, 'degraded');
    await rollup(org, s, 89, 0, 'major_outage');

    const page = await fetchPage(org.slug);
    assert.equal(page.uptime.windowDays, 90);
    assert.equal(page.uptime.services.length, 1);
    const [entry] = page.uptime.services;
    assert.equal(entry.serviceId, s);
    assert.deepEqual(
      entry.days.map((day) => day.date),
      Array.from({ length: 90 }, (_, i) => dayText(89 - i)),
    );

    const byDate = new Map(entry.days.map((day) => [day.date, day]));
    assert.deepEqual(byDate.get(dayText(0)), {
      date: dayText(0),
      uptimeRatio: 1,
      worstStatus: 'operational',
    });
    assert.deepEqual(byDate.get(dayText(5)), {
      date: dayText(5),
      uptimeRatio: 0.75,
      worstStatus: 'degraded',
    });
    assert.deepEqual(byDate.get(dayText(89)), {
      date: dayText(89),
      uptimeRatio: 0,
      worstStatus: 'major_outage',
    });
    assert.equal(typeof byDate.get(dayText(5))?.uptimeRatio, 'number');

    const empty = entry.days.filter(
      (day) => ![dayText(0), dayText(5), dayText(89)].includes(day.date),
    );
    assert.equal(empty.length, 87);
    for (const day of empty) {
      assert.equal(day.uptimeRatio, null);
      assert.equal(day.worstStatus, null);
    }
  });

  it('starts the window at today minus 89 and ignores older rollups', async () => {
    const org = await makeOrg('edge');
    const s = await createService(app, org.cookie, { name: 'S' });
    await rollup(org, s, 89, 0.5, 'degraded');
    await rollup(org, s, 90, 0.1, 'major_outage');

    const page = await fetchPage(org.slug);
    const [entry] = page.uptime.services;
    assert.equal(entry.days[0].date, dayText(89));
    assert.equal(entry.days[0].uptimeRatio, 0.5);
    assert.ok(!JSON.stringify(page.uptime).includes(dayText(90)));
  });

  it('leaves out a visible service with no rollup in the window, and keeps it in groups', async () => {
    const org = await makeOrg('norollup');
    const s1 = await createService(app, org.cookie, { name: 'S1' });
    const s2 = await createService(app, org.cookie, { name: 'S2' });
    await rollup(org, s1, 3, 1, 'operational');
    await rollup(org, s2, 90, 1, 'operational');
    await rollup(org, s2, -1, 1, 'operational');

    const page = await fetchPage(org.slug);
    assert.deepEqual(
      page.uptime.services.map((entry) => entry.serviceId),
      [s1],
    );
    assert.deepEqual(
      page.groups.flatMap((g) => g.services.map((svc) => svc.id)).sort(),
      [s1, s2].sort(),
    );
  });

  it('never carries a private or archived service', async () => {
    const org = await makeOrg('hidden');
    const visible = await createService(app, org.cookie, { name: 'Vis' });
    const priv = await createService(app, org.cookie, {
      name: 'Priv',
      isPublic: false,
    });
    const archived = await createService(app, org.cookie, { name: 'Arch' });
    for (const id of [visible, priv, archived]) {
      await rollup(org, id, 1, 1, 'operational');
    }
    await archiveService(app, org.cookie, archived);

    const rows = await withTenantTransaction(org.orgId, (tx) =>
      publicStatusRepository().listPublicUptime(tx),
    );
    assert.deepEqual([...new Set(rows.map((row) => row.serviceId))], [visible]);

    const page = await fetchPage(org.slug);
    const body = JSON.stringify(page);
    assert.deepEqual(
      page.uptime.services.map((entry) => entry.serviceId),
      [visible],
    );
    assert.ok(!body.includes(priv));
    assert.ok(!body.includes(archived));
  });

  it('is independent of the session time zone and DateStyle', async () => {
    const org = await makeOrg('tz');
    const s = await createService(app, org.cookie, { name: 'S' });
    await rollup(org, s, 0, 1, 'operational');
    await rollup(org, s, 89, 1, 'operational');

    const rows = await withTenantTransaction(org.orgId, async (tx) => {
      await tx.sql`set local time zone 'Pacific/Kiritimati'`;
      await tx.sql`set local datestyle = 'SQL, DMY'`;
      return publicStatusRepository().listPublicUptime(tx);
    });
    assert.deepEqual(
      rows.map((row) => row.date),
      Array.from({ length: 90 }, (_, i) => dayText(89 - i)),
    );
  });

  it('answers an explicit empty list for an organization with no rollups', async () => {
    const org = await makeOrg('empty');
    await createService(app, org.cookie, { name: 'S' });
    const page = await fetchPage(org.slug);
    assert.deepEqual(page.uptime, { windowDays: 90, services: [] });
  });

  it("lists services in the services list's order, not id order", async () => {
    const org = await makeOrg('order');
    const g1 = await createServiceGroup(app, org.cookie, {
      name: 'G1',
      displayOrder: 2,
    });
    const g2 = await createServiceGroup(app, org.cookie, {
      name: 'G2',
      displayOrder: 1,
    });
    const make = async (spec: object) => {
      const id = await createService(app, org.cookie, spec);
      await rollup(org, id, 1, 1, 'operational');
      return id;
    };
    const a = await make({ name: 'A', serviceGroupId: g1, displayOrder: 0 });
    const b = await make({ name: 'B', serviceGroupId: g2, displayOrder: 0 });
    // Tied on group, display order and name, so only the id orders them.
    const tied = [
      await make({ name: 'Tied', serviceGroupId: g2, displayOrder: 1 }),
      await make({ name: 'Tied', serviceGroupId: g2, displayOrder: 1 }),
    ].sort();
    // Ungrouped, given display orders in descending id order once their ids
    // are known, so the list cannot be the ids' sort order by chance.
    const ungrouped = [
      await make({ name: 'U' }),
      await make({ name: 'U' }),
      await make({ name: 'U' }),
    ]
      .sort()
      .reverse();
    for (const [displayOrder, id] of ungrouped.entries()) {
      await updateService(app, org.cookie, id, { displayOrder });
    }

    const page = await fetchPage(org.slug);
    const listed = page.groups.flatMap((g) => g.services.map((s) => s.id));
    assert.deepEqual(listed, [b, ...tied, a, ...ungrouped]);
    assert.deepEqual(
      page.uptime.services.map((entry) => entry.serviceId),
      listed,
    );
    assert.notDeepEqual(listed, [...listed].sort(), 'not just id order');
  });

  it('changes the ETag when a rollup changes', async () => {
    const org = await makeOrg('etag');
    const s = await createService(app, org.cookie, { name: 'S' });
    await rollup(org, s, 0, 1, 'operational');

    const first = await app.inject({
      method: 'GET',
      url: `/status/${org.slug}`,
    });
    const etag = first.headers.etag as string;
    assert.equal(first.statusCode, 200);

    await rollup(org, s, 0, 0.5, 'degraded');
    const second = await app.inject({
      method: 'GET',
      url: `/status/${org.slug}`,
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.statusCode, 200);
    assert.notEqual(second.headers.etag, etag);
    const day = JSON.parse(second.body).uptime.services[0].days.at(-1);
    assert.equal(day.uptimeRatio, 0.5);
  });

  it('reads uptime in the same snapshot as the rest of the page', async () => {
    const org = await makeOrg('snap');
    const s = await createService(app, org.cookie, { name: 'S' });

    const repository = app.diContainer.resolve(
      'publicStatusRepository' as never,
    ) as { listPublicUptime: (tx: TenantTransaction) => Promise<unknown> };
    const original = repository.listPublicUptime;
    repository.listPublicUptime = async (tx) => {
      await rollup(org, s, 0, 1, 'operational');
      return original.call(repository, tx);
    };

    let during: PublicStatusPageResponseDto;
    try {
      during = await fetchPage(org.slug);
    } finally {
      repository.listPublicUptime = original;
    }
    assert.deepEqual(during.uptime.services, []);

    const afterwards = await fetchPage(org.slug);
    assert.deepEqual(
      afterwards.uptime.services.map((entry) => entry.serviceId),
      [s],
    );
  });

  it('never lists another organization service', async () => {
    const a = await makeOrg('tena');
    const b = await makeOrg('tenb');
    const sa = await createService(app, a.cookie, { name: 'A' });
    const sb = await createService(app, b.cookie, { name: 'B' });
    await rollup(a, sa, 1, 1, 'operational');
    await rollup(b, sb, 1, 1, 'operational');

    const page = await fetchPage(a.slug);
    assert.deepEqual(
      page.uptime.services.map((entry) => entry.serviceId),
      [sa],
    );
    assert.ok(!JSON.stringify(page).includes(sb));
  });

  it('answers the same uptime over REST and GraphQL', async () => {
    const org = await makeOrg('parity');
    const s = await createService(app, org.cookie, { name: 'S' });
    await rollup(org, s, 2, 0.9, 'degraded');

    const rest = await fetchPage(org.slug);
    const data = await gqlData<{
      publicStatusPage: PublicStatusPageResponseDto;
    }>(
      app,
      `query ($slug: ID!) { publicStatusPage(orgSlug: $slug) {
        uptime { windowDays services { serviceId days { date uptimeRatio worstStatus } } }
      } }`,
      { variables: { slug: org.slug } },
    );
    assert.deepEqual(data.publicStatusPage.uptime, rest.uptime);
    assert.equal(rest.uptime.services.length, 1);
  });
});
