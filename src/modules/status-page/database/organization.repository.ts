import sql from '@/shared/db/postgres';

/** The organization behind a public slug. Better Auth owns these columns. */
export type PublicOrganization = {
  id: string;
  name: string;
  slug: string;
};

/**
 * The one read a request with no tenant is allowed to make.
 *
 * `/status/:orgSlug` arrives with no session, so nothing has resolved an
 * organization for it and `app.current_org_id` is unset. Better Auth's
 * `organization` table sits outside WatchDog's RLS by the decision in
 * ARCHITECTURE.md 6.4, which is what makes this lookup possible without a
 * BYPASSRLS role. Everything the page then reads is tenant-scoped and runs
 * under `withTenantTransaction`, so RLS still decides what is visible.
 *
 * Deliberately not a tenant repository: it takes no transaction, because the
 * tenant it would scope to is what it is being asked to find.
 */
export default function organizationRepository() {
  return {
    async findBySlug(slug: string): Promise<PublicOrganization | undefined> {
      const rows = await sql<PublicOrganization[]>`
        select "id", "name", "slug" from "organization"
        where "slug" = ${slug}
        limit 1
      `;
      return rows[0];
    },
  };
}
