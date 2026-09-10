import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';

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
 */

const ORIGIN = 'http://localhost:3000';
const password = 'correct-horse-battery-staple';
const tag = `lst-${randomBytes(4).toString('hex')}`;

let app: FastifyInstance;
let cookieA = '';
let cookieB = '';
let userAId = '';
let userBId = '';
let orgAId = '';
let orgBId = '';

function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function signUpWithOrg(label: string) {
  const email = `${label}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name: label },
  });
  const cookie = captureCookie(signUp.headers as Record<string, unknown>);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    select "id" from "user" where "email" = ${email}
  `;
  const org = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { cookie, origin: ORIGIN },
    payload: { name: label, slug: label },
  });
  return { cookie, userId, orgId: JSON.parse(org.body).id as string };
}

async function createService(
  cookie: string,
  slug: string,
  extra: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: { cookie, origin: ORIGIN },
    payload: { name: slug, slug, ...extra },
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body).id as string;
}

async function listSlugs(cookie: string, query = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/services${query}`,
    headers: { cookie, origin: ORIGIN },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (JSON.parse(response.body) as { slug: string }[]).map((s) => s.slug);
}

describe('Story 2.5: exclusion from active and public lists', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    ({
      cookie: cookieA,
      userId: userAId,
      orgId: orgAId,
    } = await signUpWithOrg(`${tag}-a`));
    ({
      cookie: cookieB,
      userId: userBId,
      orgId: orgBId,
    } = await signUpWithOrg(`${tag}-b`));
  });

  after(async () => {
    await sql`delete from "organization" where "id" in (${orgAId}, ${orgBId})`;
    await sql`delete from "user" where "id" in (${userAId}, ${userBId})`;
    await app.close();
    await sql.end({ timeout: 5 });
  });

  it('returns an empty collection for an organization with no services', async () => {
    assert.deepEqual(await listSlugs(cookieB), []);
  });

  it('excludes archived services from the admin list by default', async () => {
    const live = `${tag}-live`;
    const retired = `${tag}-retired`;
    await createService(cookieA, live);
    const retiredId = await createService(cookieA, retired);
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
    await createService(cookieA, hidden, { isPublic: false });

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
    await createService(cookieB, `${tag}-theirs`);

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
