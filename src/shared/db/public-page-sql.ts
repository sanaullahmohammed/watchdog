import type { PendingQuery, Row } from 'postgres';
import type { TenantTransaction } from '@/shared/db/tenant-transaction';
import { ACTIVE_INCIDENT_STATUSES } from '@/shared/domain/status-inputs';

/**
 * The SQL half of DOMAIN's "Public status page" rule. The other half,
 * `publishable` in `src/shared/domain/public-page.ts`, decides from each
 * item's `AffectedService.visible` which incidents and windows are listed;
 * these fragments are how a query computes the inputs that rule trusts. The
 * public page and the notification pass read through them, as the Atom feed
 * (story 6.8) is to, so none keeps a copy (ARCHITECTURE 5.6).
 * `src/shared/domain/public-rule-copies.spec.ts` fails on an `is_public` in
 * module SQL outside the `service` module.
 *
 * Each returns a fragment to interpolate into the caller's own query, built
 * on the caller's transaction. The caller names its alias, and the fragment
 * quotes it as an identifier, so no text reaches SQL unescaped.
 */

/**
 * The alias `publicTimelineEntry` gives its own read of `incident_updates`.
 * A caller using it for the outer row would make the inner one shadow it, so
 * every fragment refuses it.
 */
export const RESERVED_ALIAS = 'public_rule_prior';

function aliasFor(tx: TenantTransaction, alias: string) {
  if (alias === RESERVED_ALIAS) {
    throw new Error(
      `${RESERVED_ALIAS} is reserved by the public rule's fragments; give the table another alias`,
    );
  }
  return tx.sql(alias);
}

/**
 * True when the `services` row under `alias` is one the public page may show:
 * `is_public` and not archived. `AffectedService.visible` is this predicate.
 */
export function visibleService(
  tx: TenantTransaction,
  alias: string,
): PendingQuery<Row[]> {
  const s = aliasFor(tx, alias);
  return tx.sql`(${s}.is_public and ${s}.archived_at is null)`;
}

/**
 * True when the `incident_updates` row under `alias` is a public timeline
 * entry. An entry at `draft` never is: a draft was not shown to customers,
 * and nor were the notes posted to it. Nor is an entry on an incident that
 * had no public entry by then, at `investigating`, `identified` or
 * `monitoring` with a `sequence` no later than its own. That is what keeps a
 * dismissed draft's `resolved` entry off: a move out of `draft` is not a
 * public lifecycle transition (DOMAIN, IncidentUpdate). Confirming a draft
 * writes an `investigating` entry, so everything after it is public.
 */
export function publicTimelineEntry(
  tx: TenantTransaction,
  alias: string,
): PendingQuery<Row[]> {
  const entry = aliasFor(tx, alias);
  const prior = tx.sql(RESERVED_ALIAS);
  return tx.sql`(
    ${entry}.status <> 'draft'
    and exists (
      select 1 from incident_updates ${prior}
      where ${prior}.incident_id = ${entry}.incident_id
        and ${prior}.org_id = ${entry}.org_id
        and ${prior}.status in ${tx.sql(ACTIVE_INCIDENT_STATUSES)}
        and ${prior}.sequence <= ${entry}.sequence
    )
  )`;
}
