import { statusPageActionCreator } from '@/modules/status-page';
import {
  type ResolveOrganizationBySlugQueryResult,
  resolveOrganizationBySlugQuery,
} from '@/modules/status-page/queries/resolve-organization-by-slug/resolve-organization-by-slug.handler';

/**
 * The public page for one organization.
 *
 * Story 3.2 establishes the route and the organization it resolves to; story
 * 3.3 fills in the services, incidents, maintenance and uptime the wireframe
 * traced. The shape grows; the route and its 404 do not change.
 */
export type PublicStatusPage = {
  organization: { name: string; slug: string };
};

export type GetPublicStatusPageQueryResult = Promise<PublicStatusPage>;

export const getPublicStatusPageQuery = statusPageActionCreator<{
  slug: string;
}>('page.get');

export default function makeGetPublicStatusPage({ queryBus }: Dependencies) {
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

      return {
        organization: { name: organization.name, slug: organization.slug },
      };
    },
    init() {
      queryBus.register(getPublicStatusPageQuery.type, this.handler);
    },
  };
}
