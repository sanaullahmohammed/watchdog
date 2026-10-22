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

/** The oldest due delivery, locked for this transaction. */
export type ClaimedDelivery = {
  id: string;
  subscriberId: string;
  sourceType: NotificationSourceType;
  sourceId: string;
  /** Attempts already made, before this claim. */
  attempts: number;
};

/** What a send's answer does to its row. */
export type DeliveryRecord = {
  id: string;
  /** The attempt number the claim wrote; the record is guarded by it. */
  attempts: number;
  status: 'sent' | 'failed' | 'abandoned' | 'pending';
  /** Set only when given; a row keeps its last failure otherwise (a `sent` row too). */
  lastError?: string;
  /** Set only for a row that stays `pending`: the wait from now. */
  retryInSeconds: number | null;
};

/**
 * The delivery ledger, DOMAIN NotificationDelivery. Takes a
 * `TenantTransaction` per call. Claiming, leasing and recording a send are story 6.7.
 */
export default function deliveryRepository() {
  return {
    /**
     * Deletes the final deliveries (`sent`, `failed`, `abandoned`) created
     * before the retention window and before the cursor's re-read window, and
     * returns how many. The queue re-reads from `read_at - overlap`, so a
     * delivery inside that window could be queued a second time if its row
     * were gone; a delivery is never older than its change, so one outside it
     * cannot. `least` ignores a missing cursor. A `pending` delivery is never
     * pruned. One statement: the cursor is a scalar subquery, so its
     * `read_at` keeps full precision (it never passes through a JS Date).
     */
    async pruneFinal(
      tx: TenantTransaction,
      retentionDays: number,
      overlapSeconds: number,
    ): Promise<number> {
      const rows = await tx.sql`
        delete from notification_deliveries
        where org_id = ${tx.orgId}
          and status in ('sent', 'failed', 'abandoned')
          and created_at < least(
            now() - make_interval(days => ${retentionDays}),
            (
              select read_at from notification_cursors
              where org_id = ${tx.orgId}
            ) - make_interval(secs => ${overlapSeconds})
          )
        returning 1
      `;
      return rows.length;
    },

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

    /**
     * The oldest due `pending` row, or undefined. `skip locked` hands a row
     * another pass holds to no one, so of two concurrent claims each gets a
     * different row. The lock lasts to the end of the transaction only.
     */
    async claimDue(
      tx: TenantTransaction,
    ): Promise<ClaimedDelivery | undefined> {
      const rows = await tx.sql<
        {
          id: string;
          subscriber_id: string;
          source_type: NotificationSourceType;
          source_id: string;
          attempts: number;
        }[]
      >`
        select id, subscriber_id, source_type, source_id, attempts
        from notification_deliveries
        where org_id = ${tx.orgId}
          and status = 'pending'
          and next_attempt_at <= now()
        order by next_attempt_at asc, id asc
        limit 1
        for no key update skip locked
      `;
      const row = rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        subscriberId: row.subscriber_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        attempts: row.attempts,
      };
    },

    /** Deletes a row that will never be sent. */
    async drop(tx: TenantTransaction, id: string): Promise<void> {
      await tx.sql`
        delete from notification_deliveries
        where id = ${id} and org_id = ${tx.orgId}
      `;
    },

    /**
     * Gives up on a claimed row. `EUNRECORDED` marks one that reached the
     * limit through unrecorded claims, so it differs from a run of transient
     * failures; an existing diagnostic is kept.
     */
    async abandon(tx: TenantTransaction, id: string): Promise<void> {
      await tx.sql`
        update notification_deliveries
        set status = 'abandoned',
            last_error = coalesce(last_error, 'EUNRECORDED')
        where id = ${id} and org_id = ${tx.orgId} and status = 'pending'
      `;
    },

    /**
     * Leases a claimed row for attempt `attempts`: no other pass claims it
     * until `leaseSeconds` pass.
     */
    async lease(
      tx: TenantTransaction,
      id: string,
      attempts: number,
      leaseSeconds: number,
    ): Promise<void> {
      await tx.sql`
        update notification_deliveries
        set attempts = ${attempts},
            next_attempt_at = now() + make_interval(secs => ${leaseSeconds})
        where id = ${id} and org_id = ${tx.orgId}
      `;
    },

    /**
     * Records a send's answer, only if the row is still `pending` at the
     * attempt the claim wrote, so a send whose lease expired and was claimed
     * again cannot overwrite the newer attempt. Returns whether it applied.
     */
    async record(
      tx: TenantTransaction,
      record: DeliveryRecord,
    ): Promise<boolean> {
      const rows = await tx.sql<{ id: string }[]>`
        update notification_deliveries
        set status = ${record.status},
            sent_at = case when ${record.status}::text = 'sent'
              then now() else sent_at end,
            last_error = coalesce(${record.lastError ?? null}::text, last_error),
            next_attempt_at = case when ${record.retryInSeconds}::int is null
              then next_attempt_at
              else now() + make_interval(secs => ${record.retryInSeconds}::int)
              end
        where id = ${record.id}
          and org_id = ${tx.orgId}
          and status = 'pending'
          and attempts = ${record.attempts}
        returning id
      `;
      return rows.length === 1;
    },
  };
}
