import { statusPageActionCreator } from '@/modules/status-page';
import type { PublicOrganization } from '@/modules/status-page/database/organization.repository';
import type {
  PublicIncidentRow,
  PublicMaintenanceRow,
  PublicServiceRow,
  PublicStatusReads,
} from '@/modules/status-page/database/public-status.repository';
import {
  type Published,
  publishable,
} from '@/modules/status-page/domain/public-page';
import {
  type ResolveOrganizationBySlugQueryResult,
  resolveOrganizationBySlugQuery,
} from '@/modules/status-page/queries/resolve-organization-by-slug/resolve-organization-by-slug.handler';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * What one page is made of, with DOMAIN's listing rule already applied: only
 * what a visitor may see. The presenter turns this into the response both
 * surfaces send; a query may not reach into the api layer to do that itself.
 */
export type PublicStatusPageView = {
  organization: PublicOrganization;
  services: PublicServiceRow[];
  incidents: Published<PublicIncidentRow>[];
  maintenance: Published<PublicMaintenanceRow>[];
  generatedAt: Date;
};

export type GetPublicStatusPageQueryResult = Promise<PublicStatusPageView>;

export const getPublicStatusPageQuery = statusPageActionCreator<{
  slug: string;
}>('page.get');

export default function makeGetPublicStatusPage({
  publicStatusRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof getPublicStatusPageQuery
    >): GetPublicStatusPageQueryResult {
      const organization =
        await queryBus.execute<ResolveOrganizationBySlugQueryResult>(
          resolveOrganizationBySlugQuery({ slug: payload.slug }),
        );

      // The pre-tenant path ends here. Everything below runs under the
      // organization the slug resolved to, so RLS decides what is visible and
      // one page can never carry another tenant's rows.
      //
      // One transaction for all three reads: the page is a single answer, and
      // an incident that resolves between two of them would otherwise appear
      // on the timeline of a service already shown as operational.
      const reads = await withTenantTransaction(
        organization.id,
        async (tx): Promise<PublicStatusReads> => ({
          services: await publicStatusRepository.listPublicServices(tx),
          incidents: await publicStatusRepository.listActiveIncidents(tx),
          maintenance: await publicStatusRepository.listOpenMaintenance(tx),
        }),
      );

      return {
        organization,
        services: reads.services,
        incidents: publishable(reads.incidents),
        maintenance: publishable(reads.maintenance),
        generatedAt: new Date(),
      };
    },
    init() {
      queryBus.register(getPublicStatusPageQuery.type, this.handler);
    },
  };
}
