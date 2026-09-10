import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/server/build-app';
import sql from '@/shared/db/postgres';
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

describe('Better Auth over HTTP', () => {
  before(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  after(async () => {
    if (orgId) {
      await sql`delete from "organization" where "id" = ${orgId}`;
    }
    if (userId) {
      await sql`delete from "user" where "id" = ${userId}`;
    }
    await app.close();
    await sql.end({ timeout: 5 });
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
