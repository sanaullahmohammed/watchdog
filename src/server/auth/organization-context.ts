import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import sql from '@/shared/db/postgres';
import { auth } from './auth';

/**
 * Resolves session -> user -> active organization -> role.
 *
 * Runs before any repository sets `app.current_org_id`. Better Auth owns the
 * tables read here; WatchDog only reads them, and never writes them outside
 * Better Auth's own API. See ARCHITECTURE.md sections 3, 6.4 and 7.
 *
 * Every identifier below is double-quoted. `"user"` is a reserved word in
 * Postgres, `"member"` and `"session"` carry camelCase columns, and an unquoted
 * `"organizationId"` folds to `organizationid` and fails to resolve.
 */

/** v1 RBAC is Better Auth's built-in ladder. All three may perform v1 writes. */
export const ORG_ROLES = ['owner', 'admin', 'member'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

export type OrganizationContext = {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
};

export class UnknownOrganizationRoleError extends Error {
  constructor(role: string, orgId: string, userId: string) {
    super(
      `Membership of ${userId} in ${orgId} carries unknown role ${JSON.stringify(role)}`,
    );
    this.name = 'UnknownOrganizationRoleError';
  }
}

function assertKnownRole(role: string, orgId: string, userId: string): OrgRole {
  // "member"."role" is unconstrained text: the ladder is a Better Auth
  // convention, not a database guarantee, so it is validated rather than cast.
  if (!(ORG_ROLES as readonly string[]).includes(role)) {
    throw new UnknownOrganizationRoleError(role, orgId, userId);
  }
  return role as OrgRole;
}

type SessionRow = {
  userId: string;
  activeOrganizationId: string | null;
};

/** Reads the Better Auth session, or null when the request is unauthenticated. */
export async function resolveActor(
  headers: IncomingHttpHeaders,
): Promise<SessionRow | null> {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(headers),
  });

  if (!result?.session) {
    return null;
  }

  return {
    userId: result.session.userId,
    activeOrganizationId: result.session.activeOrganizationId ?? null,
  };
}

/**
 * Falls back to a membership when the session carries no active organization,
 * which is the state right after sign-in. Ordered so that the choice is stable
 * across requests rather than whatever the planner returns first.
 */
async function firstMembershipOf(userId: string): Promise<string | null> {
  const rows = await sql<{ organizationId: string }[]>`
    select m."organizationId"
    from "member" m
    where m."userId" = ${userId}
    order by m."createdAt" asc, m."id" asc
    limit 1
  `;

  return rows[0]?.organizationId ?? null;
}

/** Looks up a role, or null when the user is not a member of that org. */
export async function findOrgRole(
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  const rows = await sql<{ role: string }[]>`
    select m."role"
    from "member" m
    where m."organizationId" = ${orgId}
      and m."userId" = ${userId}
    limit 1
  `;

  const role = rows[0]?.role;

  return role === undefined ? null : assertKnownRole(role, orgId, userId);
}

/**
 * The full context a command or query handler runs under, or null when the
 * request has no session, no organization, or no membership of it.
 *
 * Returning null for a non-member is the important case: an active organization
 * id on the session is not proof of current membership, since membership can be
 * revoked while a session lives on.
 */
export async function resolveOrganizationContext(
  headers: IncomingHttpHeaders,
): Promise<OrganizationContext | null> {
  const actor = await resolveActor(headers);

  if (!actor) {
    return null;
  }

  const orgId =
    actor.activeOrganizationId ?? (await firstMembershipOf(actor.userId));

  if (!orgId) {
    return null;
  }

  const orgRole = await findOrgRole(orgId, actor.userId);

  if (!orgRole) {
    return null;
  }

  return { userId: actor.userId, orgId, orgRole };
}
