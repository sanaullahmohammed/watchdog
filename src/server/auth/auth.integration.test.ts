import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import {
  findOrgRole,
  resolveOrganizationContext,
  UnknownOrganizationRoleError,
} from './organization-context';

/**
 * Covers FR1 (auth and organizations) and FR2 (teams and membership).
 *
 * Exercises Better Auth over real HTTP through the same instance the `api`
 * entrypoint builds, rather than calling its API directly, so the Fastify
 * translation layer is under test too. Requires a migrated database.
 */

const suffix = randomBytes(4).toString('hex');
const email = `rls-auth-${suffix}@example.test`;
const password = 'correct-horse-battery-staple';
const orgSlug = `auth-org-${suffix}`;

let app: FastifyInstance;
let cookie: string;
let userId: string;
let orgId: string;

/**
 * Better Auth rejects cookie-authenticated state changes without an Origin
 * matching baseURL or a trusted origin (MISSING_OR_NULL_ORIGIN). A browser
 * sends it automatically; app.inject does not.
 */
const ORIGIN = 'http://localhost:3000';

/** Better Auth issues Set-Cookie; subsequent requests must echo it back. */
function captureCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

describe('Better Auth over HTTP', () => {
  after(async () => {
    if (orgId) {
      await sql`delete from "organization" where "id" = ${orgId}`;
    }
    if (userId) {
      await sql`delete from "user" where "id" = ${userId}`;
    }
  });

  it('signs a new user up and issues a session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: 'RLS Test User' },
    });

    assert.equal(response.statusCode, 200, response.body);

    cookie = captureCookie(response.headers as Record<string, unknown>);
    assert.ok(cookie.length > 0, 'expected a session cookie');

    const [row] = await sql<{ id: string }[]>`
      select "id" from "user" where "email" = ${email}
    `;
    assert.ok(row, 'user row should exist');
    userId = row.id;
  });

  it('signs in with the same credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password },
    });

    assert.equal(response.statusCode, 200, response.body);
    cookie = captureCookie(response.headers as Record<string, unknown>);
  });

  it('has no organization context before one exists', async () => {
    assert.equal(await resolveOrganizationContext({ cookie }), null);
  });

  it('creates an organization and makes the creator its owner', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: { cookie, origin: ORIGIN },
      payload: { name: `Auth Org ${suffix}`, slug: orgSlug },
    });

    assert.equal(response.statusCode, 200, response.body);
    orgId = JSON.parse(response.body).id;
    assert.ok(orgId, 'organization id should be returned');

    assert.equal(await findOrgRole(orgId, userId), 'owner');
  });

  it('resolves the active organization and role from the session', async () => {
    const context = await resolveOrganizationContext({ cookie });

    assert.deepEqual(context, { userId, orgId, orgRole: 'owner' });
  });

  it('resolves through membership when the session has no active org', async () => {
    // Right after sign-in the session carries no activeOrganizationId; the
    // fallback reads "member" instead.
    await sql`
      update "session" set "activeOrganizationId" = null where "userId" = ${userId}
    `;

    const context = await resolveOrganizationContext({ cookie });

    assert.deepEqual(context, { userId, orgId, orgRole: 'owner' });
  });

  it('returns no context for a request without a session', async () => {
    assert.equal(await resolveOrganizationContext({}), null);
    assert.equal(
      await resolveOrganizationContext({
        cookie: 'better-auth.session_token=nonsense',
      }),
      null,
    );
  });

  it('returns no role for a user who is not a member', async () => {
    assert.equal(await findOrgRole(orgId, 'not-a-member-id'), null);
  });

  it('refuses a membership role outside the owner/admin/member ladder', async () => {
    // "member"."role" has no CHECK constraint, so an unexpected value is
    // reachable. It must fail loudly rather than resolve to something.
    await sql`
      update "member" set "role" = 'superuser'
      where "organizationId" = ${orgId} and "userId" = ${userId}
    `;

    await assert.rejects(
      findOrgRole(orgId, userId),
      UnknownOrganizationRoleError,
    );

    await sql`
      update "member" set "role" = 'owner'
      where "organizationId" = ${orgId} and "userId" = ${userId}
    `;
  });
});

/**
 * Story 1.1 — Switch the active organization.
 *
 * Closes the clause of FR1 that had no coverage: switching is the only path
 * that writes `session.activeOrganizationId`, which every later epic reads to
 * decide which tenant a request belongs to.
 */
describe('Switching the active organization', () => {
  const switcher = `switch-${randomBytes(4).toString('hex')}`;
  const switcherEmail = `${switcher}@example.test`;
  const outsiderEmail = `outsider-${switcher}@example.test`;

  let cookie = '';
  let outsiderCookie = '';
  let switcherUserId = '';
  let outsiderUserId = '';
  let firstOrgId = '';
  let secondOrgId = '';
  let foreignOrgId = '';

  async function signUp(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: email },
    });
    assert.equal(response.statusCode, 200, response.body);
    return captureCookie(response.headers as Record<string, unknown>);
  }

  async function createOrg(
    sessionCookie: string,
    slug: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: { cookie: sessionCookie, origin: ORIGIN },
      payload: { name: slug, slug },
    });
    assert.equal(response.statusCode, 200, response.body);
    return JSON.parse(response.body).id;
  }

  function setActive(sessionCookie: string, organizationId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/organization/set-active',
      headers: { cookie: sessionCookie, origin: ORIGIN },
      payload: { organizationId },
    });
  }

  async function activeOrganizationIdOf(userId: string) {
    const rows = await sql<{ activeOrganizationId: string | null }[]>`
      select "activeOrganizationId" from "session" where "userId" = ${userId}
    `;
    return rows[0]?.activeOrganizationId ?? null;
  }

  before(async () => {
    cookie = await signUp(switcherEmail);
    [{ id: switcherUserId }] = await sql<{ id: string }[]>`
      select "id" from "user" where "email" = ${switcherEmail}
    `;
    firstOrgId = await createOrg(cookie, `${switcher}-first`);
    secondOrgId = await createOrg(cookie, `${switcher}-second`);

    // An organization this operator has no membership of.
    outsiderCookie = await signUp(outsiderEmail);
    [{ id: outsiderUserId }] = await sql<{ id: string }[]>`
      select "id" from "user" where "email" = ${outsiderEmail}
    `;
    foreignOrgId = await createOrg(outsiderCookie, `${switcher}-foreign`);
  });

  after(async () => {
    await sql`
      delete from "organization"
      where "id" in (${firstOrgId}, ${secondOrgId}, ${foreignOrgId})
    `;
    await sql`
      delete from "user" where "id" in (${switcherUserId}, ${outsiderUserId})
    `;
  });

  it('updates the session and the resolved context when switching', async () => {
    const response = await setActive(cookie, firstOrgId);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await activeOrganizationIdOf(switcherUserId), firstOrgId);
    assert.deepEqual(await resolveOrganizationContext({ cookie }), {
      userId: switcherUserId,
      orgId: firstOrgId,
      orgRole: 'owner',
    });

    const back = await setActive(cookie, secondOrgId);

    assert.equal(back.statusCode, 200, back.body);
    assert.equal(await activeOrganizationIdOf(switcherUserId), secondOrgId);
    assert.deepEqual(await resolveOrganizationContext({ cookie }), {
      userId: switcherUserId,
      orgId: secondOrgId,
      orgRole: 'owner',
    });
  });

  it('refuses to activate an organization the operator does not belong to', async () => {
    await setActive(cookie, secondOrgId);

    const response = await setActive(cookie, foreignOrgId);

    // Better Auth answers 403 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION.
    // Asserted precisely rather than as "not 200", so that a 500 from some
    // unrelated fault cannot masquerade as an authorization refusal.
    assert.equal(response.statusCode, 403, response.body);

    // The important half: the refusal must not leave the session pointing at it.
    assert.notEqual(await activeOrganizationIdOf(switcherUserId), foreignOrgId);

    const context = await resolveOrganizationContext({ cookie });
    assert.notEqual(context?.orgId, foreignOrgId);
  });
});

/**
 * Story 1.2 — Belong to more than one organization.
 *
 * Membership is built through Better Auth's invite and accept endpoints rather
 * than by inserting into its tables, because FR2's claim is that memberships
 * are *provided by* the organization plugin. A fixture that wrote "member"
 * directly would prove the query works and leave the claim untested.
 */
describe('Belonging to more than one organization', () => {
  const tag = `multi-${randomBytes(4).toString('hex')}`;
  const memberEmail = `${tag}@example.test`;
  const hostEmail = `host-${tag}@example.test`;

  let memberCookie = '';
  let hostCookie = '';
  let memberUserId = '';
  let hostUserId = '';
  let ownedOrgId = '';
  let joinedOrgId = '';

  async function signUp(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email, password, name: email },
    });
    assert.equal(response.statusCode, 200, response.body);
    return captureCookie(response.headers as Record<string, unknown>);
  }

  async function userIdFor(email: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      select "id" from "user" where "email" = ${email}
    `;
    return row.id;
  }

  before(async () => {
    memberCookie = await signUp(memberEmail);
    memberUserId = await userIdFor(memberEmail);
    hostCookie = await signUp(hostEmail);
    hostUserId = await userIdFor(hostEmail);

    // One organization this operator owns.
    const owned = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: { cookie: memberCookie, origin: ORIGIN },
      payload: { name: `${tag}-owned`, slug: `${tag}-owned` },
    });
    assert.equal(owned.statusCode, 200, owned.body);
    ownedOrgId = JSON.parse(owned.body).id;

    // One they merely belong to, joined the way a real member would.
    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: { cookie: hostCookie, origin: ORIGIN },
      payload: { name: `${tag}-joined`, slug: `${tag}-joined` },
    });
    assert.equal(joined.statusCode, 200, joined.body);
    joinedOrgId = JSON.parse(joined.body).id;

    const invite = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/invite-member',
      headers: { cookie: hostCookie, origin: ORIGIN },
      payload: {
        email: memberEmail,
        role: 'member',
        organizationId: joinedOrgId,
      },
    });
    assert.equal(invite.statusCode, 200, invite.body);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/accept-invitation',
      headers: { cookie: memberCookie, origin: ORIGIN },
      payload: { invitationId: JSON.parse(invite.body).id },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  });

  after(async () => {
    await sql`
      delete from "organization" where "id" in (${ownedOrgId}, ${joinedOrgId})
    `;
    await sql`delete from "user" where "id" in (${memberUserId}, ${hostUserId})`;
  });

  it('resolves a different role in each organization', async () => {
    assert.equal(await findOrgRole(ownedOrgId, memberUserId), 'owner');
    assert.equal(await findOrgRole(joinedOrgId, memberUserId), 'member');
  });

  it('falls back deterministically when the session has no active org', async () => {
    await sql`
      update "session" set "activeOrganizationId" = null
      where "userId" = ${memberUserId}
    `;

    const [earliest] = await sql<{ organizationId: string }[]>`
      select m."organizationId" from "member" m
      where m."userId" = ${memberUserId}
      order by m."createdAt" asc, m."id" asc
      limit 1
    `;

    const first = await resolveOrganizationContext({ cookie: memberCookie });
    const second = await resolveOrganizationContext({ cookie: memberCookie });

    assert.equal(first?.orgId, earliest.organizationId);
    assert.deepEqual(first, second, 'the fallback must not vary between calls');
  });

  it('keeps tenant data separate even for a user inside both organizations', async () => {
    // The existing isolation suite uses two organizations with no common
    // member, which is the easy case. A user legitimately inside both is where
    // a cached context or a policy keyed on the user would actually leak.
    for (const [orgId, slug] of [
      [ownedOrgId, `${tag}-in-owned`],
      [joinedOrgId, `${tag}-in-joined`],
    ] as const) {
      await withTenantTransaction(orgId, async ({ sql: tx }) => {
        await tx`
          insert into service_groups (org_id, name, slug)
          values (${orgId}, ${slug}, ${slug})
        `;
      });
    }

    for (const [orgId, ownSlug, otherSlug] of [
      [ownedOrgId, `${tag}-in-owned`, `${tag}-in-joined`],
      [joinedOrgId, `${tag}-in-joined`, `${tag}-in-owned`],
    ] as const) {
      const slugs = await withTenantTransaction(orgId, async ({ sql: tx }) => {
        const rows = await tx<{ slug: string }[]>`
          select slug from service_groups
        `;
        return rows.map((row) => row.slug);
      });

      assert.ok(slugs.includes(ownSlug), `${orgId} should see its own group`);
      assert.ok(
        !slugs.includes(otherSlug),
        `${orgId} must not see the other organization's group`,
      );
    }
  });
});

// File-level lifecycle. Every suite in this file shares one Fastify instance
// and the postgres.js singleton, so both are opened once and closed once here.
// Closing either inside a suite's teardown breaks whichever suite runs next.
after(async () => {
  await app.close();
  await sql.end({ timeout: 5 });
});
