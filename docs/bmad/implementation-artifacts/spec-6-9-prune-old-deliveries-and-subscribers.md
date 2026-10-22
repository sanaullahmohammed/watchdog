---
title: 'Story 6.9: Prune old deliveries and subscribers'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'd2609c4197c11a9e98def9fb56ad177a98b912fe'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing ever removes a delivery or a subscriber, so the ledger grows with every email and the anonymous subscribe form can fill `subscribers` with addresses that never confirm (DOMAIN, Subscriber "Never confirmed" and NotificationDelivery "Retention").

**Approach:** A worker command, `pruneNotificationsCommand({ orgId })`, run by the notification pass for each organization, deletes final deliveries and unsubscribed subscribers older than `NOTIFICATION_RETENTION_DAYS` (default 90), and pending subscribers whose token expired more than `SUBSCRIBER_PENDING_GRACE_DAYS` (default 7) ago.

## Boundaries & Constraints

**Always:**
- **Deliveries:** `status in ('sent','failed','abandoned')` and `created_at < least(now() - retention, cursor.read_at - overlap)`, the cursor read in the same transaction (`least` ignores a null). A delivery is never older than its change, so its change is outside the window the queue re-reads and is never queued twice. A `pending` delivery is never pruned, however old.
- **Unsubscribed:** `status = 'unsubscribed'` and `updated_at < now() - retention`. Its deliveries go by the existing `on delete cascade`, with no second statement.
- **Never confirmed:** `status = 'pending'` and `confirmation_expires_at < now() - grace`. A `confirmed` subscriber is never deleted, whatever its timestamps.
- "Older than" is strict. Each rule is one `delete` whose `where` holds the whole rule, inside `withTenantTransaction(orgId)`, so a row a concurrent resubscribe changes is re-checked after its lock and survives.
- A pending subscriber that was once confirmed (unsubscribed, then resubscribed) counts as never confirmed: deleting it takes its final deliveries with it before their retention. DOMAIN's rule is by status, so this is intended.
- Settings in `src/config/notification-env.ts`: `NOTIFICATION_RETENTION_DAYS` integer, default 90, 1 to 36,500; `SUBSCRIBER_PENDING_GRACE_DAYS` integer, default 7, 1 to 36,500. Grace's minimum of 1 day keeps a pending row, and its `confirmation_sent_at`, past `SUBSCRIBER_CONFIRMATION_RESEND_SECONDS`' maximum (86,400 s), so pruning never lifts the per-address throttle early.
- **In the pass:** in the queue loop, after each organization's queue command and in its own `try`, so it runs before dispatch and its time counts inside the dispatch budget. A failure logs `notification prune failed for organization` and counts toward the pass's "every organization failed". Skipped once the signal aborts. One `info` line per pass with the counts (`deliveries`, `unsubscribed`, `neverConfirmed`) when any is above 0. Counts only, never an address.
- A new migration adds partial indexes so the per-pass prune does not scan each table.

**Never:** a new event (DOMAIN's catalog has none for this); a route or resolver; an unscoped pass in a test; editing an applied migration, `docs/genesis/*` or `AGENTS.md`; `setNotFoundHandler`.

## I/O & Edge-Case Matrix

| Scenario | State | Result |
|---|---|---|
| Final deliveries | `sent`, `failed`, `abandoned` at retention + 1 min | deleted |
| Boundary | a `sent` delivery at retention − 1 min | kept |
| Cursor behind | a `sent` delivery at retention + 1 min, the cursor's `read_at` set back past it | kept |
| Pending | a `pending` delivery at retention + 1 day | kept |
| Unsubscribed | unsubscribed, `updated_at` at retention + 1 min, with a `sent` delivery inside retention | subscriber and delivery deleted |
| Recently unsubscribed | `updated_at` at retention − 1 min | kept |
| Never confirmed | pending, expired grace + 1 min ago | deleted |
| Within grace | pending, expired grace − 1 min ago | kept |
| Confirmed | confirmed, `confirmation_expires_at` and `updated_at` a year old | kept, with its pending deliveries |
| Once confirmed | pending (resubscribed), expired grace + 1 min ago, with a `sent` delivery inside retention | subscriber and delivery deleted |
| Resubscribe race | a prunable unsubscribed row, and a prunable pending one, each reissued by `requestConfirmation` in an open transaction; the prune is seen blocked on it, then the holder commits | both survive as `pending` under their original ids; the once-unsubscribed one keeps its `sent` delivery |
| Tenancy | the same aged rows in a second organization, prune scoped to the first | the second's rows kept |
| Through the pass | `runNotificationPass(app, logger, { orgIds })` over aged final deliveries and subscribers only (no `pending` delivery, which dispatch would claim) | they go, and the counts line is logged |

</frozen-after-approval>

## Code Map

- `src/worker.ts:401` `runNotificationPass` -- queue loop (prune goes here), then dispatch `rounds:`, then the summary and the every-org-failed throw. `failed` set, `options.signal`. Commands and result types are imported from their handler files (`worker.ts:28-35`).
- `src/modules/notification/commands/queue-email-notifications/queue-email-notifications.handler.ts` -- the worker-command shape to copy: `notificationActionCreator`, factory with `Dependencies`, `commandBus.register` in `init()`, repositories injected by name. No route, no schema file (no request schema beyond `orgId`; apply `assertMatchesSchema` only if the copied command does).
- `src/modules/notification/database/delivery.repository.ts` -- add `pruneFinal(tx, retentionDays, overlapSeconds)` (reads the cursor's `read_at` in its own statement); `subscriber.repository.ts` -- add `pruneUnsubscribed(tx, retentionDays)` and `pruneNeverConfirmed(tx, graceDays)`. Each returns the row count (`returning 1`, as `uptime-rollup.repository.ts` `prune` does) and names `org_id = ${tx.orgId}`.
- `database/notification-cursor.repository.ts` -- `read_at = now()` at :82; `public-history.repository.ts:283,333` re-read from `read_at - overlap`. `env.notification.cursorOverlapSeconds`.
- `queue-email-notifications.integration.test.ts:264` -- the `pg_blocking_pids` wait, for the race test.
- `db/migrations/20261022120000_create_notification_deliveries.sql`, `20261021120000_create_subscribers.sql` -- columns, the cascade FK `(subscriber_id, org_id)`, existing indexes. DELETE is granted (`20260910053718`), nothing revokes it.
- `subscriber.repository.ts` `unsubscribe` sets `updated_at = now()` and already deletes pending deliveries; `requestConfirmation` locks `for no key update` and already retries an insert when the row is deleted under it.
- `send-queued-email.handler.ts` -- a delivery deleted mid-send ends `stale` or `dropped`; no change.
- `src/config/notification-env.ts`, `notification-env.spec.ts` (per-story `describe` blocks; copy 6.6's at :281), `env.ts:165-175` (`notification.retentionDays`, `subscribe.pendingGraceDays`), `.env.example` notification block (~104-118, commented defaults).
- `src/modules/monitoring/uptime-rollups.integration.test.ts:490` -- aging rows through the app role inside `withTenantTransaction`; `src/shared/testing/fixtures.ts:455` `insertConfirmedSubscriber`. `send-queued-email.integration.test.ts` -- `newOrg`, the scoped pass, inline delivery inserts (`source_type` check at migration :26).

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/<new>_index_notification_retention.sql` -- partial indexes `notification_deliveries (org_id, created_at) where status in ('sent','failed','abandoned')` (the query's predicate, word for word), `subscribers (org_id, updated_at) where status = 'unsubscribed'`, `subscribers (org_id, confirmation_expires_at) where status = 'pending'`.
- [x] `src/config/notification-env.ts`, `env.ts`, `notification-env.spec.ts`, `.env.example` -- the two settings, a 6.9 `describe` for defaults, bounds and fractions.
- [x] `database/delivery.repository.ts`, `database/subscriber.repository.ts` -- the three prunes.
- [x] `commands/prune-notifications/prune-notifications.handler.ts` -- one transaction, three deletes, returns `{ deliveries, unsubscribed, neverConfirmed }`; exports the command and result type.
- [x] `src/worker.ts` -- the prune loop and its log line.
- [x] `src/modules/notification/prune-notifications.integration.test.ts` -- every Matrix row. Age rows in SQL with the prune's own interval expression (`now() - make_interval(days => …)` ± `interval '1 minute'`), from `env.notification.retentionDays` and `env.subscribe.pendingGraceDays`, never hard-coded 90 or 7 and never JS milliseconds. The race asserts the prune was blocked before the holder commits, and the surviving id equals the original. A header comment maps each sabotage to its test.

**Acceptance Criteria:**
- Each Matrix row is an AC: given its State, when the prune runs, then its Result.
- Sabotage, recorded in Implementation Notes, makes a test fail: no status filter on deliveries; a cutoff one day short, in each rule separately; no `least` with the cursor; no `status = 'pending'` on never-confirmed; the prune removed from the pass; ids read without a lock, then `delete … where id = any(ids)` with no rule in the delete (race).

## Design Notes

Why the strict `where` survives the race: under READ COMMITTED a `delete` that waits on a locked row re-evaluates its `where` against the committed version, so a row resubscribed to `pending` with a fresh `updated_at` no longer matches. A `select … for update` carrying the rule would be equally correct; what breaks is a rule checked only on an unlocked read, which the race sabotage uses.

No batch cap: each pass deletes what aged out in the last 30 s. A one-off large delete after lowering a setting is one statement, counted in the dispatch budget, so that pass sends less. Accepted.

A deleted subscriber's old confirm or unsubscribe link gets the existing uniform answer.

## Verification

**Commands:**
- `pnpm run check`; `pnpm run test` with `.env` and with it moved aside -- pass.
- `pnpm run test:integration` (postgres, mailpit, migrate only), `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass.

## Implementation Notes

Implemented by a Sonnet sub-agent from this spec; the main session read the diff and made two changes. The pass logged one `notification records pruned` line per organization, where the spec asks for one per pass: it now sums the counts and logs once after dispatch, and the test asserts exactly one line holding only the three counts. A test comment on `setCursorBack` described a value it does not set.

Outside the task list: 6.6's "records one organization s failure and carries on" counted 2 errors for an invalid org id; the prune throws for it too, so it now counts 3.

Sabotage, each run against `prune-notifications.integration.test.ts`, and each failed it. The sub-agent ran: no status filter on deliveries -> "keeps a pending delivery however old", "keeps a confirmed subscriber, whatever its timestamps"; no `least` with the cursor -> "keeps a delivery the cursor window still covers"; no `status = 'pending'` on never-confirmed -> "keeps a confirmed subscriber…"; grace cutoff a day short -> "deletes a pending subscriber past its grace, and keeps one inside it". The main session ran: delivery cutoff a day short -> "keeps a delivery just inside retention" (and the race test, whose delivery is one minute inside); unsubscribed cutoff a day short -> "keeps a subscriber unsubscribed just inside retention"; the prune skipped in the pass -> "goes through the pass, which logs the counts"; `pruneUnsubscribed` as an unlocked id read then `delete … where id = any(ids)` -> "survives a resubscribe that holds the row" (`unsubscribed` 1, expected 0).
After the review pass 1 patches (11 to 19), the main session ran these further sabotages against the suite, and each failed it: `pruneNeverConfirmed` as an unlocked id read then delete by id -> "survives a resubscribe that holds the row (pending)"; `failed.add` removed from the prune's catch -> "a prune failure counts toward every organization failed"; the abort check removed -> "skips the prune once the signal aborts"; a log line per organization -> "logs one line for the whole pass, holding the totals"; `unsubscribe` no longer setting `updated_at` -> "keeps a subscriber unsubscribed through the code" and the once-confirmed test; the overlap dropped from the cursor cutoff -> "keeps a delivery the cursor window still covers".

**Verification (main session, 2026-10-22).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (543 modules).
- `pnpm run test`: 468/468 with `.env`, and again with it moved aside.
- `pnpm run test:integration` (postgres and mailpit only): 848/848, first run.
- `pnpm run test:e2e`: 86 steps pass. `pnpm run auth:schema:check`: in sync.

**Verification (main session, 2026-10-22, after the review pass 1 patches 11 to 19).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (543 modules).
- `pnpm run test`: 468/468 with `.env`, and again with it moved aside.
- `pnpm run test:integration` (postgres and mailpit only): 852/852, first run.
- `pnpm run test:e2e`: 86 steps pass. `pnpm run auth:schema:check`: in sync.

## Spec Change Log

## Review Triage Log

Spec review, before approval (one reviewer, same model as the session).

1. high, fixed -- the race sabotage (lock-then-delete with the rule) could not fail, and the race test could pass with no wait or by re-insert. Sabotage now an unlocked read; the test waits on `pg_blocking_pids` and asserts the same id.
2. medium, fixed -- the queue re-reads from `read_at - overlap`, so a delivery pruned by age alone could be queued again. Cutoff is now `least` with the cursor; "Cursor behind" row added; the accepted exception is gone.
3. medium, fixed -- prune moved before dispatch, inside the budget.
4. medium, fixed -- the pass row seeds no `pending` delivery.
5. medium-low, fixed -- grace minimum raised to 1 day, which keeps the per-address throttle; no cross-field check needed.
6. low, fixed -- `index.ts` exports no commands; the worker imports from the handler.
7. low, fixed -- index predicate matches the query.
8. low, fixed -- the cutoff sabotage applies to each rule.
9. low, fixed -- rows aged in SQL with the prune's interval.
10. low, fixed -- reissue race for a pending row, and the once-confirmed row, added.

Pass 1 (blind hunter, edge case hunter, verification gap; same model as the session). No intent gap or bad spec.

11. medium, patch -- the race test proves the lock only for the unsubscribed rule: the prune blocks in `pruneUnsubscribed`, so `pruneNeverConfirmed` runs after the holder commits and its unlocked-read sabotage would pass (blind hunter; edge case hunter, two findings).
12. medium, patch -- a prune failure counting toward "every organization failed" is untested; deleting `failed.add` from the prune's catch passes, because the 6.6 test's invalid id already failed queueing; its log message is unasserted (verification gap; blind hunter).
13. low, patch -- the abort skip before the prune is untested (verification gap; blind hunter).
14. low, patch -- the pass test uses one organization, so one line per organization would also pass (blind hunter).
15. low, patch -- `pruneFinal` passes `read_at` back as `::timestamptz`, which postgres.js sends through a JS Date and truncates to milliseconds, against `notification-cursor.repository.ts`'s documented form; the cutoff only moves earlier, so nothing is wrongly deleted. One `delete` with a scalar subquery instead (blind hunter).
16. low, patch -- `deliveries` excludes rows removed by the subscriber cascade, undocumented (blind hunter; edge case hunter).
17. low, patch -- no test unsubscribes through the code, so `unsubscribe` dropping `updated_at = now()` passes; the once-confirmed test builds a plain pending row; several tests never assert counts (verification gap; blind hunter).
18. low, patch -- the cursor test ages delivery and `read_at` in two transactions, so a no-overlap sabotage fails only by milliseconds of `now()` order (blind hunter).
19. low, patch -- the test's `prune` helper restates the result type; a doc comment names a parameter that does not exist; `.env.example` refers to the settings by line order (blind hunter).
20. false -- "a missing cursor prunes by retention alone, and a missing cursor re-reads all history" (blind hunter). Deliveries are created only by the queue command, which advances `read_at` in the same transaction, and the cursor row goes only with its organization; a null `read_at` means no delivery exists to prune.
21. false -- "a pending subscriber with a null `confirmation_expires_at` is never pruned" (blind hunter). `requestConfirmation` sets the expiry on insert (`subscriber.repository.ts:186`) and on every reissue (:223); only a test's raw insert makes that row.
22. false -- "a prune-only failure makes the pass reject" (edge case hunter). That is the frozen rule: a prune failure counts toward "every organization failed".
23. low, reject -- prune every 30 s rather than hourly, and no batch cap for a backlog (blind hunter; edge case hunter). The frozen block runs it each pass; Design Notes accept no cap. The tables are days old at deploy, so no backlog exists.
24. low, reject -- a delivery can be a few milliseconds older than its change, when the change's transaction commits inside the queue's (edge case hunter). Re-queueing needs the cursor to stall at that exact point for the whole retention.
25. low, reject -- raising `NOTIFICATION_CURSOR_OVERLAP_SECONDS` widens the re-read over already-pruned deliveries (edge case hunter). With retention at least 1 day and overlap at most 1 day it needs a stalled cursor too.
26. low, reject -- `holdTransaction` and `waitUntilBlockedBy` duplicate a test helper and could move to `src/shared/testing/` (blind hunter). Moving it touches another suite; not a direct correction.
27. low, defer -- nothing pins the `env.ts` mapping of the two settings; swapping them passes, as for every other mapping (verification gap).
28. low, defer -- `requestConfirmation`'s "deleted between the insert and the lock" retry is now reachable on a schedule and untested; hitting it needs a hook between two statements (verification gap).
29. low, defer -- ARCHITECTURE 5.6 does not say the notification pass prunes, and line 178's worker retention list omits it (blind hunter). DOMAIN already names both settings. Genesis wording is the owner's.
