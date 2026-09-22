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
      // The three reads share one snapshot: repeatable read, read only. Under
      // the default, read committed, each statement would see what had
      // committed when it began, and an incident declared between two of them
      // could appear on a page whose services were read before it existed.
      //
      // One snapshot is not one answer about status, though. A service's
      // `last_known_status` is written by a recomputation that runs after the
      // command that moved it commits (DOMAIN, "Status settles just after the
      // command that moved it"), so for as long as that handler takes, the
      // page can list a new incident beside services still showing their
      // previous status. The banner folds in listed incidents' impact, so it
      // does not wait for the recomputation.
      const reads = await withTenantTransaction(
        organization.id,
        async (tx): Promise<PublicStatusReads> => ({
          services: await publicStatusRepository.listPublicServices(tx),
          incidents: await publicStatusRepository.listActiveIncidents(tx),
          maintenance: await publicStatusRepository.listOpenMaintenance(tx),
        }),
        { isolation: 'repeatable read', readOnly: true },
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
