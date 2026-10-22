import sql from '@/shared/db/postgres';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/** The organization behind a public slug. Better Auth owns these columns. */
export type SubscribableOrganization = {
  id: string;
  name: string;
  slug: string;
  /** For the feed's id date (story 6.8). */
  createdAt: Date;
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
        select "id", "name", "slug", "createdAt" from "organization"
        where "slug" = ${slug}
        limit 1
      `;
      return rows[0];
    },

    /**
     * The same read by id, for the sender (story 6.7). On the claim's own
     * transaction, so a claim never waits on a second connection while it
     * holds a row lock.
     */
    async findById(
      tx: TenantTransaction,
      id: string,
    ): Promise<SubscribableOrganization | undefined> {
      const rows = await tx.sql<SubscribableOrganization[]>`
        select "id", "name", "slug", "createdAt" from "organization"
        where "id" = ${id}
        limit 1
      `;
      return rows[0];
    },
  };
}
