import type { TenantTransaction } from '@/shared/db/tenant-transaction';

/**
 * What the request did to the row:
 * - `inserted`: a new pending row.
 * - `returned`: an unsubscribed row back to pending.
 * - `reissued`: a pending row given a new token.
 * - `unchanged`: throttled, or already confirmed. Nothing is sent.
 */
export type SubscribeOutcome =
  | 'inserted'
  | 'returned'
  | 'reissued'
  | 'unchanged';

export type SubscribeResult = {
  subscriberId: string;
  outcome: SubscribeOutcome;
};

type LockedRow = { id: string; status: string; throttled: boolean };

/**
 * Takes a `TenantTransaction` per call, like every tenant repository. Every
 * time comparison and stored time is the database's `now()`, so a request that
 * waited on the row lock reads what its rival just wrote.
 */
export default function subscriberRepository() {
  return {
    /**
     * Deletes subscribers unsubscribed longer than `retentionDays` ago, and
     * their deliveries with them through the foreign key's cascade. The whole
     * rule is in the `delete`, so a row a concurrent resubscribe changed is
     * re-checked after its lock and survives. Returns how many.
     */
    async pruneUnsubscribed(
      tx: TenantTransaction,
      retentionDays: number,
    ): Promise<number> {
      const rows = await tx.sql`
        delete from subscribers
        where org_id = ${tx.orgId}
          and status = 'unsubscribed'
          and updated_at < now() - make_interval(days => ${retentionDays})
        returning 1
      `;
      return rows.length;
    },

    /**
     * Deletes pending subscribers whose token expired more than `graceDays`
     * ago. A confirmed subscriber is never deleted. Returns how many.
     */
    async pruneNeverConfirmed(
      tx: TenantTransaction,
      graceDays: number,
    ): Promise<number> {
      const rows = await tx.sql`
        delete from subscribers
        where org_id = ${tx.orgId}
          and status = 'pending'
          and confirmation_expires_at < now() - make_interval(days => ${graceDays})
        returning 1
      `;
      return rows.length;
    },

    /**
     * The address of `subscriberId` while it is `confirmed`, else undefined.
     * No row lock: unsubscribe locks the subscriber and then deletes its
     * deliveries, so a claim holding a delivery must not wait on the
     * subscriber (story 6.7).
     */
    async confirmedAddress(
      tx: TenantTransaction,
      subscriberId: string,
    ): Promise<string | undefined> {
      const rows = await tx.sql<{ email: string }[]>`
        select email from subscribers
        where id = ${subscriberId} and org_id = ${tx.orgId}
          and status = 'confirmed'
      `;
      return rows[0]?.email;
    },

    /**
     * Confirms the pending, unexpired row holding `tokenHash`, in one
     * statement, so of two concurrent confirms exactly one gets the row.
     * Returns the id, or undefined when no row qualifies.
     */
    async confirm(
      tx: TenantTransaction,
      tokenHash: string,
    ): Promise<string | undefined> {
      const rows = await tx.sql<{ id: string }[]>`
        update subscribers
        set status = 'confirmed',
            confirmed_at = now(),
            confirmation_token_hash = null,
            updated_at = now()
        where org_id = ${tx.orgId}
          and confirmation_token_hash = ${tokenHash}
          and status = 'pending'
          and confirmation_expires_at > now()
        returning id
      `;
      return rows[0]?.id;
    },

    /**
     * Unsubscribes `subscriberId` under a row lock and clears its confirm
     * token. `unsubscribed` is true only when this call changed the row, so
     * of two concurrent calls one reports it. `missing` when no such row.
     *
     * Under the same lock, and whether or not the row was already
     * unsubscribed, it deletes the subscriber's `pending` deliveries: an
     * unsubscribe stops every one (DOMAIN, NotificationDelivery). The
     * notification pass locks the subscribers it writes for `for share`, so
     * a pass in flight finishes first and its rows are deleted here, and a
     * pass that comes later no longer finds the subscriber confirmed.
     */
    async unsubscribe(
      tx: TenantTransaction,
      subscriberId: string,
    ): Promise<'missing' | 'unchanged' | 'unsubscribed'> {
      const locked = await tx.sql<{ id: string; status: string }[]>`
        select id, status from subscribers
        where id = ${subscriberId} and org_id = ${tx.orgId}
        for no key update
      `;
      const row = locked[0];
      if (!row) return 'missing';
      await tx.sql`
        delete from notification_deliveries
        where subscriber_id = ${row.id}
          and org_id = ${tx.orgId}
          and status = 'pending'
      `;
      if (row.status === 'unsubscribed') return 'unchanged';
      await tx.sql`
        update subscribers
        set status = 'unsubscribed',
            confirmation_token_hash = null,
            updated_at = now()
        where id = ${row.id} and org_id = ${tx.orgId}
      `;
      return 'unsubscribed';
    },

    /**
     * The ids of every confirmed subscriber, locked `for share` until the
     * transaction ends, for the notification pass to write deliveries for.
     * `status` is in the `where`, so a row whose unsubscribe commits while
     * this waits for its lock is re-checked and left out. An unsubscribe that
     * starts later waits for this transaction, then deletes what it wrote.
     */
    async lockConfirmed(tx: TenantTransaction): Promise<string[]> {
      const rows = await tx.sql<{ id: string }[]>`
        select id from subscribers
        where org_id = ${tx.orgId} and status = 'confirmed'
        order by id asc
        for share
      `;
      return rows.map((row) => row.id);
    },

    /**
     * Applies DOMAIN's state rules to `email` (already normalised) under a row
     * lock. Nothing here quotes the address in an error.
     */
    async requestConfirmation(
      tx: TenantTransaction,
      input: {
        email: string;
        tokenHash: string;
        ttlHours: number;
        resendSeconds: number;
      },
    ): Promise<SubscribeResult> {
      const { email, tokenHash, ttlHours, resendSeconds } = input;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const inserted = await tx.sql<{ id: string }[]>`
          insert into subscribers (
            org_id, email, status, confirmation_token_hash,
            confirmation_expires_at, confirmation_sent_at
          )
          values (
            ${tx.orgId}, ${email}, 'pending', ${tokenHash},
            now() + make_interval(hours => ${ttlHours}), now()
          )
          on conflict (org_id, lower(email)) do nothing
          returning id
        `;
        if (inserted[0]) {
          return { subscriberId: inserted[0].id, outcome: 'inserted' };
        }

        const locked = await tx.sql<LockedRow[]>`
          select
            id,
            status,
            coalesce(
              confirmation_sent_at > now() - make_interval(secs => ${resendSeconds}),
              false
            ) as throttled
          from subscribers
          where org_id = ${tx.orgId} and lower(email) = ${email}
          for no key update
        `;
        const row = locked[0];
        // Deleted between the insert and the lock: insert again once.
        if (!row) continue;

        if (row.throttled || row.status === 'confirmed') {
          return { subscriberId: row.id, outcome: 'unchanged' };
        }

        await tx.sql`
          update subscribers
          set status = 'pending',
              confirmation_token_hash = ${tokenHash},
              confirmation_expires_at = now() + make_interval(hours => ${ttlHours}),
              confirmation_sent_at = now(),
              confirmed_at = null,
              updated_at = now()
          where id = ${row.id} and org_id = ${tx.orgId}
        `;
        return {
          subscriberId: row.id,
          outcome: row.status === 'unsubscribed' ? 'returned' : 'reissued',
        };
      }

      throw new Error('Could not record the subscription');
    },
  };
}
