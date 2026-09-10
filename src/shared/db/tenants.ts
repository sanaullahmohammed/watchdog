import sql from '@/shared/db/postgres';

/**
 * Every organization id, for processes that have no request and therefore no
 * tenant context.
 *
 * Reads Better Auth's `organization`, which sits outside WatchDog's tenant RLS
 * by the decision in ARCHITECTURE.md 6.4. That is what makes it legible to a
 * process with no `app.current_org_id` set, and why no BYPASSRLS role is
 * needed to schedule work. See ARCHITECTURE.md 6.0.
 *
 * The work itself still runs per tenant, under `withTenantTransaction`.
 */
export async function listOrganizationIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select "id" from "organization" order by "createdAt" asc, "id" asc
  `;
  return rows.map((row) => row.id);
}
