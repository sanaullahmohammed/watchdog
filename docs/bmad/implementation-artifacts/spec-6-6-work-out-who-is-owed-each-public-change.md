---
title: 'Story 6.6: Work out who is owed each public change'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: '8071bce389ced3deaecd4e6ce455f75fdf561c66'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Confirmed subscribers are told nothing. No ledger records what each one is owed, and the "what is public" rule is partly SQL inside `status-page`, which `notification` cannot import.

**Approach:**
- A worker loop runs a per-organization pass. The pass reads public changes recorded since a per-organization cursor, re-reading an overlap behind it.
- It writes one `pending` delivery per (confirmed subscriber, change) and emits `notification.email_queued` for each one inserted.
- Unsubscribing removes the subscriber's `pending` deliveries.
- The SQL half of the public rule moves into `src/shared`, so the page and the pass apply one definition, and a guard spec stops copies coming back.
- This closes the three "From Story 6.5" deferred entries that target 6.6.

## Boundaries & Constraints

**Always:**
- **Tables** match DOMAIN NotificationDelivery and NotificationCursor exactly. RLS is enabled and `FORCE`d, with the `<table>_org_isolation` policy. `notification_deliveries_once_uk` is present. The subscriber FK is `(subscriber_id, org_id) -> subscribers (id, org_id) on delete cascade`. The cursor's `org_id` references `"organization"("id") on delete cascade`.
- **Sources.** Only the services half of the public rule applies: `publishable`, judged on current rows. The page's active-incident and open-window filter does not apply, because DOMAIN "What notifies" includes resolutions and completions.
  - `incident_update`: an entry whose status is not `draft`, on an incident that has an entry at `investigating`, `identified` or `monitoring` with `sequence` ≤ its own. A dismissed draft's `resolved` entry is therefore never owed: DOMAIN IncidentUpdate says "a move out of `draft` is not a public lifecycle transition", and that a draft was never shown to customers.
  - `maintenance_scheduled`, `_started` and `_completed` come from the window's `created_at`, `started_at` and `completed_at`. Each is filtered on its own: a window that qualifies for one kind does not bring back the others.
- **Who is owed.** A subscriber with `status = 'confirmed'` whose `confirmed_at` is earlier than the source's recorded time. They are selected `for share`, with that status in the `WHERE`, in the insert's transaction. The lock is taken only when at least one source survives `publishable`.
- **Cursor.**
  - Read incident entries with `sequence > incident_update_sequence`, or `created_at >= read_at - overlap`.
  - Read maintenance with `ts > coalesce(maintenance_read_at, '-infinity')`, or `ts >= read_at - overlap`. A null `read_at` has no overlap branch.
  - So the first pass reads the whole history, and `confirmed_at` bounds what it owes.
  - The positions then advance to the greatest of the old value and every row scanned, public or not.
  - `read_at` is set to the transaction's `now()`.
  - The cursor row is locked `for update`, so passes for one organization serialize.
  - Accepted: a source left out because it named only hidden services becomes owed if one of them is made public while it is still inside the overlap. DOMAIN judges the rule at delivery creation.
- **Insert and emit.** Insert with `on conflict do nothing returning`. Emit `notification.email_queued` after commit, for returned rows only. The payload is ids only (`orgId`, `deliveryId`, `subscriberId`, `sourceType`, `sourceId`), never an address.
- **The pass** follows ARCHITECTURE 6.0, as `runWorkerPass` does: `{ orgIds }` or tenant discovery, never overlapping itself, a per-organization failure recorded and skipped. It rejects only when discovery fails or every organization fails.
- **Settings.**
  - `NOTIFICATION_PASS_INTERVAL_MS`: default 30,000, from 1,000 to 2,147,483,647, and below `WORKER_PASS_OVERDUE_MS`.
  - `NOTIFICATION_CURSOR_OVERLAP_SECONDS`: default 300, from 1 to 86,400.
- **Unsubscribe** deletes the subscriber's `pending` deliveries under its existing `for no key update`, on both the `unsubscribed` and the `unchanged` outcome.
- Every test runs the pass scoped with `{ orgIds }`.

**Never:**
- Sending, claiming, retrying, or dropping deleted-window deliveries. Those are story 6.7.
- No feed, no prune, no wake-up on `NOTIFY`.
- No SQL view, because a view runs as its owner and skips RLS. No `tx.sql.unsafe`.
- Editing an applied migration, `docs/genesis/*` or `AGENTS.md`. Calling `setNotFoundHandler`.
- No change to what the public page returns. Its existing tests pass unedited.

**Decision (owner, 2026-10-22): an exception to Constraint 1.** This story edits `status-page` only to swap its visibility and draft-era predicates for the shared fragments. The page's tests stay unedited, as proof the page is unchanged. The constraint exists because cross-module imports are forbidden, and here neither module imports the other: both import `src/shared`.

## I/O & Edge-Case Matrix

| Scenario | State | Owed |
|---|---|---|
| Public entry | 2 confirmed subscribers, 1 posted update | 2 `pending` rows, 2 `email_queued` |
| Draft-era / dismissed | entries at `draft`; a dismissal, with a second, public incident in the same organization | none for the draft; the public incident's entries only |
| Confirmed draft | `draft -> investigating`, then resolve | both entries |
| Hidden services | an incident or window names only private or archived services | none; naming none, or one visible service, is owed |
| Subscriber state | pending, unsubscribed, or confirmed after the change | none |
| Window lifecycle | created, started, completed; scheduled straight to completed; edited; deleted before the pass | 3; 2; edit adds none; delete adds none |
| First pass | a window and entries from before the first pass | owed if `confirmed_at` is earlier |
| Repeat / overlap | pass twice; entry N commits after N+1 was read | no new rows; N owed on the next pass |
| Unsubscribe | has `pending` rows | all removed |

</frozen-after-approval>

## Code Map

- `public-status.repository.ts:127,171,226,304` (visible service) and `:243-248` (`status <> 'draft'`, no alias today) -- switch every one to the fragments.
- `src/shared/domain/public-page.ts` -- `publishable` and `AffectedService`. Widen the doc comment at :8-12 and the one on `visible` to cover the page, feed and emails.
- `src/shared/db/foreign-table-allowlist.spec.ts:205-218` -- a listed table that is never read fails. Its `sqlTemplates` and file walk move to a non-spec helper, because importing a spec re-registers its tests.
- `subscriber.repository.ts:62-80` -- `unsubscribe` locks `for no key update`. Confirm sets `confirmed_at = now()`. Re-subscribing nulls it (:139); unsubscribing does not.
- `transition-due-maintenance/` -- the shape of a per-org worker command.
- `src/worker.ts` -- the pattern is `runMonitorPass` plus `startLoop`. Add the loop to `createWorkerHealth({ loops })`, `shutdown()` and `startWorker({ orgIds })`. `runWorkerPass:291` has the rule for when a pass rejects.
- `src/config/worker-intervals.ts` -- requires `WORKER_PASS_OVERDUE_MS` above each interval. These set the overdue value below 30,000: `docker-compose.backplane.yml:44` (10000), `worker-lifecycle.integration.test.ts` (:202-507), and `worker-health.integration.test.ts` (:27, :58).
- `realtime-event.spec.ts:82-105` -- a new events file is added to its imports, `EXPORTED_CREATORS` and `IMPORTED_EVENT_FILES`.
- `incident-concurrency.integration.test.ts:240` -- sleeps before committing. The new tests wait on `pg_blocking_pids` instead.
- `maintenance.repository.ts:146-176` -- start and complete are stamped with the command's `now`. Tests keep it near real time.

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/<ts>_create_notification_deliveries.sql`:
  - both tables;
  - checks on `source_type`, `status`, and `attempts >= 0`;
  - RLS;
  - `next_attempt_at` and `created_at` default to `now()`;
  - indexes on `(org_id, next_attempt_at) where status = 'pending'`, on `incident_updates (org_id, sequence)` and on `incident_updates (org_id, created_at)`, because the pass's `or` read would otherwise scan the table.
- [x] `src/shared/db/public-page-sql.ts`:
  - `visibleService(tx, alias)` and `publicTimelineEntry(tx, alias)` return fragments, with identifiers through `tx.sql(alias)`;
  - the inner alias is reserved and refused as the caller's alias;
  - a doc comment links them to `public-page.ts`.
- [x] `public-status.repository.ts` -- use the fragments at every Code Map site.
- [x] `src/shared/domain/public-page.ts` -- doc comments only.
- [x] `src/shared/domain/public-rule-copies.spec.ts`:
  - under `src/modules`, fail on a `FunctionDeclaration`, a `MethodDeclaration`, or a variable or property whose initializer is a function, named `publishable` or `overallStatus`;
  - fail on `is_public` in any `sql` template outside `service`;
  - a renamed copy gets past it, and that is accepted.
- [x] `src/shared/events/notification.events.ts` -- `notificationEmailQueuedEvent`, plus its spec wiring.
- [x] `src/modules/notification/database/{delivery,notification-cursor,public-history}.repository.ts` -- every method takes a `TenantTransaction`.
- [x] `src/modules/notification/commands/queue-email-notifications/` -- the per-org command. It has no route.
- [x] `unsubscribe/` and `subscriber.repository.ts` -- delete `pending` deliveries.
- [x] `notification-env.ts`, `env.ts`, `worker-intervals.ts` and their specs, plus `.env.example`, `docker-compose.backplane.yml`, `worker-lifecycle.integration.test.ts` and `worker-health.integration.test.ts` -- set the interval below each overdue value.
- [x] `src/worker.ts` -- `runNotificationPass(app, logger, { orgIds? })` and `NOTIFICATION_LOOP`.
- [x] `foreign-table-allowlist.spec.ts` -- `OWNED.notification` gets the two tables. `FOREIGN.notification` gets only the tables the pass's own SQL reads.
- [x] `src/shared/testing/fixtures.ts` -- add a confirmed subscriber with a chosen `confirmed_at`, so the before and after rows do not depend on the WSL clock.
- [x] `src/modules/notification/queue-email-notifications.integration.test.ts` -- every Matrix row, and the ACs.
- [x] `deferred-work.md` -- mark the three "From Story 6.5" entries targeting 6.6 as done by this spec.

**Acceptance Criteria:**
- Given a test transaction that has run the unsubscribe `UPDATE` and not committed, when a pass starts, then it waits until `pg_blocking_pids` shows the test's pid. Once the test commits, the pass inserts nothing for that subscriber.
- Given a test transaction that holds the subscriber `for share` and has inserted a `pending` row, when the real unsubscribe runs, then it waits, shown by `pg_blocking_pids`. Once the test commits, no `pending` row remains.
- Given the new tables, when `tenant-rls-coverage.integration.test.ts` runs, then it passes.
- Constraint 11 is recorded in the Implementation Notes. Each of these must make its test fail:
  - removing the overlap branch;
  - removing `for share`;
  - removing the dismissal clause;
  - copying `publishable` into a module.

## Design Notes

The pass, in one tenant transaction:
1. Upsert the cursor and lock it `for update`.
2. Read the sources, with their affected services computed by `visibleService`.
3. Apply `publishable`.
4. Lock confirmed subscribers `for share`.
5. Insert, returning the new rows.
6. Advance the cursor.
7. Commit, then emit.

The fragments read `incident_updates` from `src/shared`, which the allowlist does not scan. The callers' own SQL still names the tables.

## Verification

**Commands:**
- `pnpm run check` -- passes.
- `pnpm run test`, with `.env` present and again with it moved aside -- passes.
- `pnpm run test:integration` (postgres, mailpit and migrate only), `pnpm run test:e2e`, `pnpm run auth:schema:check`, and the `test:compose` stack -- pass.

## Implementation Notes

**The accepted overlap re-judgement (Boundaries, Cursor).** A source left out because every service it named was hidden is not remembered as refused. If one of those services is made public while the source is still inside the overlap (`NOTIFICATION_CURSOR_OVERLAP_SECONDS`, default 300 s, measured back from the previous pass's `read_at`), the next pass reads it again, judges it on the current rows, and owes it. Once it is outside the overlap and behind the cursor it is never read again, so it is never owed. This is DOMAIN's "the rule applies at the moment a delivery is created", and is accepted. The per-kind maintenance read is what stops it spreading: `reads each of its changes on its own` shows a window's start being owed after its service was made public, while its scheduling, read once and outside the overlap, is not.

**Sabotage, each run against the finished code and reverted (epics.md Story Generation Constraint 11, "a fix's test is mutation-checked").**
- Removing the overlap branch of the incident read (`or iu.created_at >= read_at - overlap`): `owes an entry that commits after a later one was read, on the next pass` fails.
- Removing the overlap branch of the maintenance read (`or k.recorded_at >= read_at - overlap`): `owes a window start that commits after a later change was read, on the next pass` fails with an `AssertionError` (main session, after review pass 1; restored byte-identical, suite 17/17).
- Removing `for share` from `subscriberRepository.lockConfirmed`: `makes a pass wait for an unsubscribe in flight` fails, timing out on `pg_blocking_pids`.
- Removing the dismissal clause (the `exists` in `publicTimelineEntry`): `never owes a draft-era entry or a dismissal` fails.
- Copying `publishable` into the notification handler: `public-rule-copies.spec.ts` fails, naming the file. Writing `is_public` into the notification module's SQL fails it too.

**Positions cross as text.** postgres.js serializes a parameter the server types as `timestamptz` through a JS `Date`, which keeps milliseconds only. The first version stored `maintenance_read_at` that way, so the cursor sat just below the row it had read and read it again; the per-kind test caught it. Every timestamp and `bigint` the pass hands back to SQL is now text, cast from `text` in the query (`${v}::text::timestamptz`).

**Choices the spec left open.**
- `lockConfirmed` locks every confirmed subscriber of the organization, not only those confirmed before the latest source; the insert's join applies `confirmed_at < recorded_at` per pair. The insert also repeats `status = 'confirmed'`.
- Deleting `pending` deliveries on unsubscribe lives in `subscriberRepository.unsubscribe`, after its `for no key update` and before the `unchanged` return, so both outcomes delete under the same lock.
- `sqlTemplates` and the file walk moved to `src/shared/testing/source-scan.ts`. The allowlist spec no longer exports its helpers.
- `notify-listener.integration.test.ts` also starts a worker with `WORKER_PASS_OVERDUE_MS=20000`, so it sets `NOTIFICATION_PASS_INTERVAL_MS` too, though the Code Map does not list it.
- The worker-lifecycle suite now also waits for the notification loop and checks that a scoped worker leaves a cursor only on its own organization.

**Verification (main session, 2026-10-22, after the review patches).**
- `pnpm run check` passes. Its 11 Biome warnings are all in files this story does not touch. dependency-cruiser finds no violations across 525 modules.
- `pnpm run test`: 441/441 with `.env` present, and again with it moved aside.
- `pnpm run test:integration`, with only postgres, mailpit and migrate up:
  - First run: 791/792. `public-status-payload` "shows active incidents newest first" ordered by `started_at` while the journal logged "Time jumped backwards" (the WSL clock, AGENTS.md).
  - That test then passed alone three times, and the full suite passed 792/792 on rerun.
  - The story does not touch that query.
- `pnpm run test:e2e`: 10 scenarios and 86 steps pass.
- `pnpm run auth:schema:check`: in sync.
- The `test:compose` backplane stack passes 2/2, then `down -v`.
- The changed migration was rolled back and re-applied locally. `incident_updates_org_id_idx` is gone, and the two `(org_id, …)` indexes are present.

## Spec Change Log

## Review Triage Log

Pass 1 (blind hunter, edge case hunter, verification gap; same model as the session). No intent gap or bad spec, so no loopback.

1. medium, patch — the maintenance read's overlap branch had no test that needed it (verification gap). A start stamped before a later window's `created_at` commits, after the cursor passed it, would never be owed. Fixed: `owes a window start that commits after a later change was read, on the next pass`, mutation-checked in Implementation Notes.
2. low, patch — the hidden-services test's "not vacuous" check compared two fresh UUIDs (blind hunter). Replaced with a check that the cursor's `maintenance_read_at` reached both windows' `created_at`.
3. low, patch — the foreign-table allowlist cannot see the reads inside `src/shared/db/public-page-sql.ts` fragments (blind hunter; edge case hunter). Today both callers list the tables anyway. A comment beside `FOREIGN` now says a caller of `publicTimelineEntry` lists `incident_updates` and a caller of `visibleService` lists `services`.
4. low, patch — `incident_updates_org_id_idx (org_id)` became redundant with the new `(org_id, sequence)` index (blind hunter). Dropped in this story's migration, and recreated in its down.
5. low, patch — `MaintenanceSourceType` re-declared three strings already in `NotificationSourceType` (blind hunter). Now `Exclude<NotificationSourceType, 'incident_update'>`.
6. low, patch — ARCHITECTURE.md's module table (line 49) names `QueueEmailNotificationCommand`; the code said `queueEmailNotificationsCommand` (blind hunter). Renamed the creator to `queueEmailNotificationCommand`, type `queue_email_notification`. The folder keeps the name the story's file list gives.
7. false — the first pass owes every change since each subscriber confirmed, which could be a backlog (blind hunter; edge case hunter). The frozen Matrix row "First pass" requires exactly this, and DOMAIN's cursor starts at 0. Nothing is sent before 6.7, and no release exists.
8. low, reject — `started_at` and `completed_at` come from the worker's clock, everything else from the database's (blind hunter; edge case hunter). A change is missed only if the two clocks differ by more than the 300 s overlap. Compose runs both on one host's clock. The fix would change the maintenance module.
9. low, reject — a pass has no size bound (blind hunter; edge case hunter). `insertPending` passes arrays, one parameter each, so only `in ${tx.sql(ids)}` grows with input. It fails above 65,535 distinct incidents or windows in one read, which a status page does not reach. Lock time grows with sources × subscribers: 1,000 subscribers × 10 changes is 10,000 rows in one insert.
10. low, reject — no `lock_timeout`, so one organization's pass can hold up the others (edge case hunter). Only two things block it: another pass on the same cursor, which is the designed serialization, and an unsubscribe, a single-row transaction.
11. false — a subscriber who confirms while a change's transaction is still open is not owed it (edge case hunter). DOMAIN NotificationDelivery says "confirmed before it was recorded", and the change was recorded first.
12. false — a window completed while still `scheduled` owes a `maintenance_completed` (edge case hunter). DOMAIN "What notifies" includes completion, and the state machine allows that move. How the email words it belongs to story 6.7, so a deferred-work entry targets 6.7 (Constraint 10).
13. low, reject — a deployment with `WORKER_PASS_OVERDUE_MS` at 30,000 or below will not boot after upgrading (edge case hunter). The default is 120,000. The cross-check names both variables, and `.env.example` documents the bound. No release exists yet.
14. low, reject — the copy guard does not catch a pasted `status <> 'draft'` on `incident_updates` (blind hunter). The 6.5 deferral asked for `publishable`, `overallStatus` and the visible-service SQL. A draft rule would also have to tell apart the incident module's legitimate `status <> 'draft'` on `incidents`.
15. low, reject — `realtime-event.spec.ts` keeps its own source walker (blind hunter). It is untouched by this story apart from three list entries, and the walkers differ in what they read.
16. low, reject — the maintenance scan reads all of an organization's windows each pass (blind hunter). An organization has tens to hundreds of windows, and the incident table is the one that grows.
17. low, reject — nothing tests that the cursor never moves backwards (blind hunter). A backwards cursor only re-reads, and the unique key absorbs the repeat.
18. false — "the diff leaves out the story's spec" (blind hunter). The review procedure withholds the spec from that layer on purpose.
