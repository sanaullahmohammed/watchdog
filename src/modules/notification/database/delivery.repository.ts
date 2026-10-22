import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import type { NotificationSourceType } from '@/shared/events/notification.events';

/** A public change some subscribers may be owed. */
export type OwedSource = {
  sourceType: NotificationSourceType;
  sourceId: string;
  /** When the change was recorded, as text from the database. */
  recordedAt: string;
};

/** A delivery this call wrote. */
export type QueuedDelivery = {
  id: string;
  subscriberId: string;
  sourceType: NotificationSourceType;
  sourceId: string;
};

/**
 * The delivery ledger, DOMAIN NotificationDelivery. Takes a
 * `TenantTransaction` per call. Sending, claiming and retrying are story 6.7.
 */
export default function deliveryRepository() {
  return {
    /**
     * One `pending` delivery for each pair of a source and a subscriber in
     * `subscriberIds` who was confirmed before the source was recorded. The
     * caller has locked those subscribers. A pair already in the ledger is
     * left alone, so only the rows this call wrote come back.
     */
    async insertPending(
      tx: TenantTransaction,
      sources: readonly OwedSource[],
      subscriberIds: readonly string[],
    ): Promise<QueuedDelivery[]> {
      if (sources.length === 0 || subscriberIds.length === 0) return [];
      const rows = await tx.sql<
        {
          id: string;
          subscriber_id: string;
          source_type: NotificationSourceType;
          source_id: string;
        }[]
      >`
        insert into notification_deliveries (
          org_id, subscriber_id, source_type, source_id, status
        )
        select ${tx.orgId}, s.id, o.source_type, o.source_id, 'pending'
        from (
          select
            unnest(${sources.map((source) => source.sourceType)}::text[])
              as source_type,
            unnest(${sources.map((source) => source.sourceId)}::uuid[])
              as source_id,
            unnest(${sources.map((source) => source.recordedAt)}::text[]::timestamptz[])
              as recorded_at
        ) o
        join subscribers s
          on s.id = any(${subscriberIds}::uuid[])
          and s.status = 'confirmed'
          and s.confirmed_at < o.recorded_at
        order by o.recorded_at asc, o.source_id asc, s.id asc
        on conflict (subscriber_id, source_type, source_id) do nothing
        returning id, subscriber_id, source_type, source_id
      `;
      return rows.map((row) => ({
        id: row.id,
        subscriberId: row.subscriber_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
      }));
    },
  };
}
