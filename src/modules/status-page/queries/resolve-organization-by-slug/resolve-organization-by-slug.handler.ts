import { statusPageActionCreator } from '@/modules/status-page';
import type { PublicOrganization } from '@/modules/status-page/database/organization.repository';
import { assertValidBetterAuthOrgId } from '@/shared/db/tenant-transaction';
import { isSlug } from '@/shared/domain/slug';
import { NotFoundException } from '@/shared/exceptions';

export type ResolveOrganizationBySlugQueryResult = Promise<PublicOrganization>;

/**
 * The pre-tenant step of every public read: slug in, organization out.
 *
 * Its own query rather than a helper inside the page handler, because Epic 4's
 * SSE route at `/status/:orgSlug/events` needs exactly this and nothing else.
 * ARCHITECTURE.md section 5.5 already sketches it making this call.
 */
/** The one answer every miss gets, whatever was asked for. */
const NOT_FOUND = 'Status page not found';

export const resolveOrganizationBySlugQuery = statusPageActionCreator<{
  slug: string;
}>('organization.resolve');

export default function makeResolveOrganizationBySlug({
  organizationRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof resolveOrganizationBySlugQuery
    >): ResolveOrganizationBySlugQueryResult {
      // The page answers only for slugs inside WatchDog's slug rule (DOMAIN,
      // Better-Auth-owned references). Anything else gets the answer an
      // unknown slug gets, before it reaches SQL: a NUL byte there was a
      // database error, a 500 over REST and Postgres's own message over
      // GraphQL. Checking length first is also what makes it safe for the
      // router to pass a slug of any length through to here (ARCHITECTURE 6.4).
      if (!isSlug(payload.slug)) {
        throw new NotFoundException(NOT_FOUND);
      }

      const organization = await organizationRepository.findBySlug(
        payload.slug,
      );

      // One answer for every slug that resolves to nothing, so the route
      // cannot be used to learn which organizations exist.
      if (!organization) {
        throw new NotFoundException(NOT_FOUND);
      }

      // The same guard every tenant entry point applies, before this id
      // reaches a transaction and becomes `app.current_org_id`.
      assertValidBetterAuthOrgId(organization.id);

      return organization;
    },
    init() {
      queryBus.register(resolveOrganizationBySlugQuery.type, this.handler);
    },
  };
}
