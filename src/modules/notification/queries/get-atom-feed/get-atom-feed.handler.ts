import { notificationActionCreator } from '@/modules/notification';
import type { SubscribableOrganization } from '@/modules/notification/database/organization-by-slug.repository';
import type { LatestChange } from '@/modules/notification/database/public-history.repository';
import { withTenantTransaction } from '@/shared/db/tenant-transaction';
import { type Published, publishable } from '@/shared/domain/public-page';
import { PUBLIC_PAGE_NOT_FOUND } from '@/shared/domain/public-page-miss';
import { isSlug } from '@/shared/domain/slug';
import { NotFoundException } from '@/shared/exceptions';

/** The feed holds at most this many entries. */
export const FEED_ENTRIES = 50;
/** Candidates are read this many at a time. */
export const FEED_BATCH = 100;
/**
 * At most this many batches are read, so an anonymous request never walks an
 * unbounded history: past the cap the feed holds what it found, possibly
 * fewer than `FEED_ENTRIES` (owner, 2026-10-22).
 */
export const FEED_MAX_BATCHES = 10;

export type AtomFeedEntry = Published<
  Omit<LatestChange, 'ownerId'> & {
    affectedServices: { serviceId: string; visible: boolean }[];
  }
>;

export type AtomFeedView = {
  organization: SubscribableOrganization;
  entries: AtomFeedEntry[];
};

export type GetAtomFeedQueryResult = Promise<AtomFeedView>;

export const getAtomFeedQuery = notificationActionCreator<{ slug: string }>(
  'feed.get',
);

export default function makeGetAtomFeed({
  organizationBySlugRepository,
  publicHistoryRepository,
  queryBus,
}: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<typeof getAtomFeedQuery>): GetAtomFeedQueryResult {
      // One answer for every slug that names no page.
      if (!isSlug(payload.slug)) {
        throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);
      }
      const organization = await organizationBySlugRepository.findBySlug(
        payload.slug,
      );
      if (!organization) throw new NotFoundException(PUBLIC_PAGE_NOT_FOUND);

      // One snapshot: a change committed between two batches must not make
      // the keyset skip or repeat an entry.
      const entries = await withTenantTransaction(
        organization.id,
        async (tx) => {
          const kept: AtomFeedEntry[] = [];
          let before: LatestChange['position'] | null = null;

          for (let read = 0; read < FEED_MAX_BATCHES; read += 1) {
            const batch: LatestChange[] =
              await publicHistoryRepository.latestChanges(
                tx,
                before,
                FEED_BATCH,
              );
            const incidentServices =
              await publicHistoryRepository.incidentServices(tx, [
                ...new Set(
                  batch
                    .filter((c) => c.sourceType === 'incident_update')
                    .map((c) => c.ownerId),
                ),
              ]);
            const windowServices =
              await publicHistoryRepository.maintenanceServices(tx, [
                ...new Set(
                  batch
                    .filter((c) => c.sourceType !== 'incident_update')
                    .map((c) => c.ownerId),
                ),
              ]);

            // The shared rule, on current rows, as the queue command applies it.
            kept.push(
              ...publishable(
                batch.map(({ ownerId, ...change }) => ({
                  ...change,
                  affectedServices:
                    (change.sourceType === 'incident_update'
                      ? incidentServices
                      : windowServices
                    ).get(ownerId) ?? [],
                })),
              ),
            );

            if (kept.length >= FEED_ENTRIES || batch.length < FEED_BATCH) break;
            before = batch[batch.length - 1].position;
          }
          return kept.slice(0, FEED_ENTRIES);
        },
        { isolation: 'repeatable read', readOnly: true },
      );

      return { organization, entries };
    },
    init() {
      queryBus.register(getAtomFeedQuery.type, this.handler);
    },
  };
}
