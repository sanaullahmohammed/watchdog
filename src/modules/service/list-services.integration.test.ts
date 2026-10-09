import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { createService } from '@/shared/testing/fixtures';
import { gqlData } from '@/shared/testing/graphql';
import { signUpWithOrg } from '@/shared/testing/tenant';

/**
 * Story 2.5 — exclusion from active and public lists.
 *
 * Exclusion is two independent axes. `archived_at` retires a service from every
 * surface; `is_public` hides a live one from public surfaces only. Conflating
 * them is how a non-public service leaks onto a public read model, so each is
 * asserted on its own as well as together.
 *
 * The public read model itself is Epic 3's. The filtering rule lives here,
 * in the module that owns services, so that page composes rather than
 * reimplements it.
 *
 * Story 9.8 adds the tie-ordering tests: the list ends its order on `id`.
 */

const ORIGIN = 'http://localhost:3000';
const tag = `lst-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';

async function listSlugs(cookie: string, query = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/services${query}`,
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (JSON.parse(response.body) as { slug: string }[]).map((s) => s.slug);
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await sql.end({ timeout: 5 });
});

describe('Story 2.5: exclusion from active and public lists', () => {
  before(async () => {
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(app, `${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(app, `${tag}-b`));
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
  });

  it('returns an empty collection for an organization with no services', async () => {
    assert.deepEqual(await listSlugs(cookieB), []);
  });

  it('excludes archived services from the admin list by default', async () => {
    const live = `${tag}-live`;
    const retired = `${tag}-retired`;
    await createService(app, cookieA, { name: live, slug: live });
    const retiredId = await createService(app, cookieA, {
      name: retired,
      slug: retired,
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/services/${retiredId}/archive`,
      headers: { cookie: cookieA, origin: ORIGIN },
    });

    const slugs = await listSlugs(cookieA);

    assert.ok(slugs.includes(live));
    assert.ok(
      !slugs.includes(retired),
      'archived services are excluded by default',
    );
  });

  it('returns archived services when explicitly asked, so one can be restored', async () => {
    const slugs = await listSlugs(cookieA, '?includeArchived=true');

    assert.ok(
      slugs.includes(`${tag}-retired`),
      'the archived service must be findable',
    );
    assert.ok(
      slugs.includes(`${tag}-live`),
      'the filter widens rather than replaces',
    );
  });

  it('hides a non-public service from public surfaces while keeping it on admin', async () => {
    const hidden = `${tag}-internal`;
    await createService(app, cookieA, {
      name: hidden,
      slug: hidden,
      isPublic: false,
    });

    const admin = await listSlugs(cookieA);
    const publicOnly = await listSlugs(cookieA, '?publicOnly=true');

    assert.ok(
      admin.includes(hidden),
      'a non-public service is still an admin concern',
    );
    assert.ok(
      !publicOnly.includes(hidden),
      'is_public is a second axis; a live service can be hidden without being archived',
    );
  });

  it('never returns an archived service to a public surface, filter or not', async () => {
    const publicOnly = await listSlugs(cookieA, '?publicOnly=true');
    const both = await listSlugs(
      cookieA,
      '?publicOnly=true&includeArchived=true',
    );

    assert.ok(!publicOnly.includes(`${tag}-retired`));
    assert.ok(
      !both.includes(`${tag}-retired`),
      'includeArchived is an admin affordance; it must not reopen a public surface',
    );
  });

  it('keeps each organization listing only its own', async () => {
    await createService(app, cookieB, {
      name: `${tag}-theirs`,
      slug: `${tag}-theirs`,
    });

    const mine = await listSlugs(cookieA, '?includeArchived=true');
    const theirs = await listSlugs(cookieB, '?includeArchived=true');

    assert.ok(!mine.includes(`${tag}-theirs`));
    assert.ok(
      !theirs.some(
        (slug) => slug.startsWith(`${tag}-`) && slug !== `${tag}-theirs`,
      ),
    );
  });
});

describe('Story 9.8: service lists settle ties by id', () => {
  let cookie = '';
  let userId = '';
  let orgId = '';

  // Fewer than 7 rows on purpose: Postgres sorts that few with a stable
  // insertion sort, so a tie keeps scan order. At 7 or more its quicksort may
  // reorder equal keys and the test could pass without `id asc`.
  before(async () => {
    ({ cookie, userId, orgId } = await signUpWithOrg(app, `${tag}-ties`));
    await createService(app, cookie, {
      name: 'Zulu',
      slug: `${tag}-zulu`,
      displayOrder: 0,
    });
    // Larger id inserted first and given the earlier slug. Insertion order is
    // usually heap order, and slug order (which the planner may also use) is
    // the reverse of id order regardless, so a missing `id asc` shows up.
    // Alpha gets the largest id of the three display_order = 1 rows, so an
    // order by display_order, id, name would put it last and fail.
    const [lowId, highId, alphaId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ].sort();
    await withTenantTransaction(orgId, async ({ sql: tx }) => {
      await tx`
        insert into services (id, org_id, name, slug, display_order)
        values (${alphaId}, ${orgId}, 'Alpha', ${`${tag}-alpha`}, 1)
      `;
      await tx`
        insert into services (id, org_id, name, slug, display_order)
        values (${highId}, ${orgId}, 'Tie', ${`${tag}-tie-a`}, 1)
      `;
      await tx`
        insert into services (id, org_id, name, slug, display_order)
        values (${lowId}, ${orgId}, 'Tie', ${`${tag}-tie-b`}, 1)
      `;
    });
  });

  after(async () => {
    await sql`delete from "organization" where "id" = ${orgId}`;
    await sql`delete from "user" where "id" = ${userId}`;
  });

  const expected = [
    `${tag}-zulu`,
    `${tag}-alpha`,
    `${tag}-tie-b`,
    `${tag}-tie-a`,
  ];

  it('orders by display order, name, then id on every REST variant', async () => {
    for (const query of ['', '?includeArchived=true', '?publicOnly=true']) {
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await listSlugs(cookie, query), expected, query);
      }
    }
  });

  it('orders the same way over GraphQL', async () => {
    const data = await gqlData<{ services: { slug: string }[] }>(
      app,
      '{ services { slug } }',
      { cookie },
    );
    assert.deepEqual(
      data.services.map((s) => s.slug),
      expected,
    );
  });
});
