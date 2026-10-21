import sql from '@/shared/db/postgres';

/** The organization behind a public slug. Better Auth owns these columns. */
export type SubscribableOrganization = {
  id: string;
  name: string;
  slug: string;
};

/**
 * The one read the subscribe route makes with no tenant, copied from
 * status-page's because modules never import each other. `"organization"` sits
 * outside WatchDog's RLS (ARCHITECTURE 6.4), so it is read on the global
 * connection; everything after it runs in a tenant transaction.
 */
export default function organizationBySlugRepository() {
  return {
    async findBySlug(
      slug: string,
    ): Promise<SubscribableOrganization | undefined> {
      const rows = await sql<SubscribableOrganization[]>`
        select "id", "name", "slug" from "organization"
        where "slug" = ${slug}
        limit 1
      `;
      return rows[0];
    },
  };
}
