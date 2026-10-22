---
title: 'Story 6.7: Send owed emails, with retries'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'adc5523966c35be620d5e28f14709c66ac6f5c50'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.6 writes a `pending` delivery for every change a confirmed subscriber is owed, but nothing sends them. Subscribers still hear nothing.

**Approach:**
- After queueing, the notification pass sends due deliveries one at a time: claim one row in a short transaction, send it with no transaction open, record the SMTP answer in a second transaction.
- A transient failure waits and retries, doubling, until it is `abandoned`. A permanent failure is `failed` at once.
- Each email is plain text, names the organization and the change, links to the public page, and carries the signed unsubscribe link in its body and in `List-Unsubscribe` headers.
- This closes the two deferred-work entries that target 6.7 ("From Story 6.2" and "From Story 6.6").

## Boundaries & Constraints

**Always:**
- **Claim** (`SendQueuedEmailCommand`, ARCHITECTURE 5.6 and line 49). One transaction picks the oldest due row: `status = 'pending' and next_attempt_at <= now()`, ordered by `next_attempt_at, id`, `limit 1 for update skip locked`. In the same transaction it either:
  - **drops** the row (deletes it, sends nothing, emits nothing) when its source row no longer exists, or its subscriber's status is not `confirmed`; or
  - **abandons** it when `attempts >= NOTIFICATION_MAX_ATTEMPTS` already (a crash or a throw after an earlier claim left it unrecorded), and emits `notification.email_failed` after commit; or
  - **leases** it: with `n` the new attempt number, `attempts = n` and `next_attempt_at = now() + delay(n)`, so no other pass claims it while its send can run.
- The claim reads the subscriber and the source **without a row lock**. Unsubscribe locks the subscriber, then deletes deliveries; a claim that locked the delivery and then the subscriber could deadlock with it.
- The content (organization, subscriber address, source rows) is read in the claim transaction. The email is built after it commits.
- One row per claim, so every lease starts just before its own send. No batch leases.
- **Send** happens after the claim commits, with no transaction open, through the `emailSender` DI singleton.
- **Record** in a second transaction, guarded by `id`, `status = 'pending'` and the claimed `attempts`, so a send whose lease expired and was claimed again cannot overwrite the newer attempt. When the guard matches nothing, nothing is emitted.
  - `accepted` → `sent`, `sent_at = now()`, then emit `notification.email_sent`.
  - `permanent` → `failed`, `last_error = diagnostic`, then emit `notification.email_failed`.
  - `transient` → `last_error = diagnostic`, `next_attempt_at = now() + delay(n)`, so each wait is measured from the failure; the row stays `pending`. If `attempts >= NOTIFICATION_MAX_ATTEMPTS` it becomes `abandoned` and `notification.email_failed` is emitted. A comment there says an abandoned send (`EDEADLINE`) may still arrive, so a retry can duplicate it: at-least-once, accepted (ARCHITECTURE 5.6).
- **Backoff:** `delay(n) = min(base × 2^(n−1), maxDelay)` seconds, `n` the attempt that failed. Defaults give waits of 60, 120, 240, 480, 960, 1920 and 3600 s after attempts 1 to 7; attempt 8 is abandoned.
- **Settings** (`notification-env.ts`, `.env.example`):
  - `NOTIFICATION_RETRY_BASE_SECONDS`: default 60, from 60 to 86,400. The minimum is `SMTP_TIMEOUTS.overall` (45 s) plus the 15 s socket limit, so no lease ends while its send can still run; `smtp-email-sender.spec.ts` fails if the two drift (a `domain/` spec importing `infrastructure/` would break dependency-cruiser).
  - `NOTIFICATION_RETRY_MAX_DELAY_SECONDS`: default 3,600, at most 604,800, and not below the base; boot fails naming both.
  - `NOTIFICATION_MAX_ATTEMPTS`: default 8, from 1 to 100.
- **Events** `notificationEmailSentEvent` and `notificationEmailFailedEvent`, payload `NotificationDeliveryEventPayload` (ids only), emitted after the record commits.
- **No address in logs or `last_error`.** `last_error` is the sender's diagnostic only. Each pass logs transient outcomes once, at `warn`, as counts per diagnostic, so a wrong SMTP setting is visible without a line per row.
- **The pass** (`runNotificationPass`): queue every organization as today, then dispatch round-robin over every visited organization (including one whose queueing failed, since its earlier rows are still owed), one row per organization per round, dropping an organization from the rounds when it has nothing due or its send command threw.
  - **Budget.** `min(NOTIFICATION_PASS_INTERVAL_MS, WORKER_PASS_OVERDUE_MS − NOTIFICATION_PASS_INTERVAL_MS − (SMTP_TIMEOUTS.overall + 10 s))`, never below 0, measured with `performance.now()` (the WSL clock steps back) from the start of the pass, so a pass plus one send still completes inside the health limit. The option `dispatchBudgetMs` overrides it for tests.
  - **Decision (owner, 2026-10-22): the time limit wins over one send per organization.** The budget is checked before every claim, not once per round. A pass makes at least one claim in total. Each pass starts its rounds one organization further along than the last, so every organization gets its turn even when the budget allows one claim.
  - When the budget is 0, the worker logs one `warn` at start naming `WORKER_PASS_OVERDUE_MS` and `NOTIFICATION_PASS_INTERVAL_MS`: it will send one email per pass.
  - It also stops claiming when its `signal` aborts. A send in flight finishes and is recorded.
  - An organization fails if its queueing or any of its dispatch commands threw. The pass rejects only on failed discovery or every organization failing.
- **Shutdown** stops the claiming, then waits for the pass in flight as it does today, so it waits for the send in flight.
- **Email wording** (owner to confirm at approval). Times are UTC as `2026-10-22 14:05 UTC`. Subject line breaks become spaces. Every body ends with the page link (`<PUBLIC_BASE_URL>/status/<slug>`) and the unsubscribe link.

  | Source | Subject | Body says |
  |---|---|---|
  | incident update | `[<Org>] <incident title>: <Status>` | the status, the entry's message, when it was posted |
  | scheduled | `[<Org>] Maintenance scheduled: <title>` | scheduled start and end, and the description if any |
  | started | `[<Org>] Maintenance started: <title>` | when it started, the scheduled end |
  | completed, `started_at` set | `[<Org>] Maintenance completed: <title>` | when it completed |
  | completed, `started_at` null | `[<Org>] Maintenance ended without starting: <title>` | "This maintenance window ended without starting." and its scheduled times |

- Content is read from current rows when the row is claimed.
- Tests run the pass scoped with `{ orgIds }`, use Mailpit with a unique recipient to prove delivery, and replace `send` on the resolved sender singleton for failures. They move `next_attempt_at` back with SQL rather than wait, and reach "not confirmed" by setting the status with SQL (unsubscribe deletes the row).

**Never:**
- A lock or open transaction across a send. A batch lease.
- Sending to a subscriber who is not `confirmed` at claim time, or about a deleted window.
- An HTML part. A new dependency. A `NOTIFY` wake-up. Pruning (story 6.9). The feed (6.8).
- Editing an applied migration, `docs/genesis/*` or `AGENTS.md`. Calling `setNotFoundHandler`.

## I/O & Edge-Case Matrix

| Scenario | State | Result |
|---|---|---|
| Happy path | one due delivery, Mailpit up | `sent`, `sent_at`, `attempts = 1`, one email with both headers, `email_sent` |
| Transient | sender answers `transient` every time | waits 60, 120 … 3600; after attempt 8 `abandoned`, `email_failed`, `last_error` set |
| Permanent | sender answers `permanent` (`SMTP 550`) | `failed` after one attempt, `email_failed`, `last_error = 'SMTP 550'` |
| Two passes | two dispatches over the same rows at once | each row sent exactly once |
| Crash | `pending`, `attempts = 1`, lease in the past | claimed again, `attempts = 2`, sent |
| Crash at the limit | `pending`, `attempts = 8`, lease in the past | `abandoned` at claim, nothing sent, `email_failed` |
| Stale record | lease expires mid-send and another pass claims and sends | the late record changes nothing and emits nothing |
| Deleted window | window deleted after queueing | row deleted, nothing sent |
| Not confirmed | subscriber no longer `confirmed` | row deleted, nothing sent |
| Never-started completion | completed while `scheduled` | the "ended without starting" email |
| Not due | `next_attempt_at` in the future | not claimed |

</frozen-after-approval>

## Code Map

- `src/modules/notification/database/delivery.repository.ts` -- add `claimDue`, `drop`, `recordSent`, `recordFailed`, `recordTransient` (or one `record`); every method takes a `TenantTransaction`. Timestamps cross back to SQL as text (6.6 Implementation Notes, "Positions cross as text").
- `src/modules/notification/commands/queue-email-notifications/queue-email-notifications.handler.ts` -- the shape of a per-org worker command (registration, `withTenantTransaction`, emit after commit).
- `src/modules/notification/domain/email-sender.port.ts` -- `EmailMessage`, `SendResult`. `send` never throws.
- `src/modules/notification/infrastructure/smtp-email-sender.ts:34` -- `SMTP_TIMEOUTS.overall` 45 s. Do not change the sender.
- `src/modules/notification/domain/unsubscribe-link.ts` -- `unsubscribeLink(publicBaseUrl, orgSlug, orgId, subscriberId, secret)`; secret is `env.notificationLinkSecret`, base is `env.publicBaseUrl`.
- `src/modules/notification/domain/confirmation-email.ts` -- the style for a pure email builder; the new builder lives beside it as `notification-email.ts`.
- `src/server/di/index.ts:22` -- `emailSender` singleton. Tests replace `send` on `app.diContainer.resolve('emailSender')`.
- `src/shared/events/notification.events.ts` -- add the two creators. `realtime-event.spec.ts` already lists both names as "No"; it checks each creator has an emit site.
- `src/config/notification-env.ts`, `src/config/env.ts:163` (`env.notification`) -- three settings and the max-delay cross-check.
- `src/worker.ts:382` `runNotificationPass`, `:553` loop, `:564` shutdown -- add the dispatch phase and a stop signal (`AbortSignal` option, aborted first in `shutdown`).
- `src/shared/db/foreign-table-allowlist.spec.ts:65` -- add `incidents` (the email's incident title).
- `src/shared/testing/mailpit.ts` -- `uniqueRecipient`, `messagesTo`. `src/shared/testing/fixtures.ts` -- 6.6's confirmed-subscriber fixture.
- `src/modules/notification/queue-email-notifications.integration.test.ts` -- how 6.6's tests build the app, seed changes and run the pass scoped.
- `maintenance.repository.ts` hard-deletes windows; `incident_updates` cannot be deleted. Completing a `scheduled` window leaves `started_at` null.

## Tasks & Acceptance

**Execution:**

Pass 1 is in `git stash` as "story 6.7 pass 1 (review loopback 1)". Restore it with `git stash apply` (not `pop`, until this pass is verified), keep what the KEEP list in the Spec Change Log names, and change only what the tasks below require.

- [x] `src/config/notification-env.ts`, `env.ts`, their specs, `.env.example` -- the three settings and the cross-check. `NOTIFICATION_RETRY_MAX_DELAY_SECONDS` minimum 60, with 59/60 bound cases.
- [x] `src/config/retry-delays.integration.test.ts` (or an `it` in `subscribe-limits.integration.test.ts`) -- spawn `src/index.ts api` with base 120 and max 119: non-zero exit, message naming both.
- [x] `src/modules/notification/domain/retry-delay.ts` + spec -- `retryDelaySeconds(attempt, base, maxDelay)`; the spec pins the default schedule.
- [x] `src/modules/notification/infrastructure/smtp-email-sender.spec.ts` -- the base minimum × 1000 is at least `SMTP_TIMEOUTS.overall + SMTP_TIMEOUTS.socket`.
- [x] `src/modules/notification/domain/notification-email.ts` + spec -- one builder per Matrix wording row, both `List-Unsubscribe` headers, no line break in a subject.
- [x] `src/shared/events/notification.events.ts` -- the two creators.
- [x] `delivery.repository.ts` -- claim (`for no key update skip locked`), drop, abandon (sets `last_error = 'EUNRECORDED'` when it is null), lease, record. `record` sets `last_error` only when a diagnostic is given; a `sent` row keeps its last failure, and the handler passes no `null` that reads as clearing it.
- [x] `organization-by-slug.repository.ts` -- `findById(tx, id)` on the claim's transaction.
- [x] `send-queued-email.handler.ts` -- outcomes `none | stale | dropped | sent | retrying | failed | abandoned`, with `diagnostic` for `retrying`, `failed` and `abandoned` after a send. No route.
- [x] `src/worker.ts`:
  - `dispatchBudgetMs(intervalMs, overdueMs)` exported and pure, with `src/worker-dispatch-budget.spec.ts` (30,000/120,000 → 30,000; 60,000/120,000 → 5,000; negative → 0);
  - the budget checked before every claim, from the start of the pass; at least one claim per pass; a module-level turn counter that starts each pass one organization further along;
  - dispatch over every visited organization, whether or not its queueing failed;
  - `stale` keeps the organization in the rounds;
  - one `warn` per pass with counts per diagnostic, split into `retrying`, `abandoned` and `failed`;
  - the start-up `warn` when the budget is 0;
  - `signal` aborted first in `shutdown`.
- [x] `foreign-table-allowlist.spec.ts` -- `incidents`.
- [x] `src/modules/notification/send-queued-email.integration.test.ts` -- every Matrix row and the ACs, plus:
  - two organizations with several due rows each and `dispatchBudgetMs: 0`: two consecutive passes send one row for each;
  - a `send` that throws for one organization: the other is still sent, one error is logged, the pass resolves; with only the throwing organization it rejects with `every organization failed (1)`;
  - a pass whose budget is spent mid-round leaves the later organization's row `pending` and unleased;
  - an incident with two entries (investigating, then resolved): each email's `Text` carries its own entry's status, message and posted time;
  - the emailed `List-Unsubscribe` link, followed with `app.inject` by `GET` and by the one-click `POST`, answers 200 and unsubscribes;
  - a header comment that maps each sabotage to the test that catches it, by its real name;
  - no comment that does not parse.
- [x] `queue-email-notifications.integration.test.ts` -- its `pass` helper queues only (as pass 1 did).
- [x] `deferred-work.md` -- the "From Story 6.2" and "From Story 6.6" entries resolved; add the two deferred findings from the Review Triage Log (16 and 17).

**Acceptance Criteria:**
- Given a stub `send` that, while running, locks the claimed row `for update nowait` from the test's own transaction, when the pass sends, then the lock succeeds (no transaction holds the row), and the row already shows `attempts = 1` and `next_attempt_at` about 60 s after the claim.
- Given a send in flight and shutdown starting, when the pass is aborted, then it claims nothing more, and resolves only after that send's outcome is recorded.
- Given a dispatch with more due rows than fit in the budget, when the budget runs out, then the pass resolves with the rest still `pending` and not leased.
- Given a pass with transient failures, then exactly one `warn` line summarises them, and no log line or `last_error` holds the recipient's address.
- Sabotage, each recorded in Implementation Notes, makes its test fail: removing `skip locked`; removing the `attempts` guard on the record; removing the drop of a deleted window.

## Design Notes

The send loop, per organization, one row at a time:

```
claim (tx 1): pick 1 due row for update skip locked
              → gone source / unconfirmed subscriber: delete, return 'dropped'
              → attempts >= max: abandoned, return 'abandoned'
              → else n = attempts+1, next_attempt_at = now()+delay(n), read content
send (no tx): emailSender.send(buildNotificationEmail(content))
record (tx 2): update … where id and status='pending' and attempts=claimed
emit after commit
```

A crash, or a throw after the claim commits, leaves a leased row unrecorded. It is claimed again when the lease ends, and abandoned at claim once it reaches the limit.

Accepted: an unsubscribe that commits after the claim, before or during the send, cannot recall the email; its delete removes the row, so the record finds nothing and nothing is emitted. An abandoned send's socket can outlive `EDEADLINE` by up to the 15 s inactivity limit; the process stays alive until it closes, which shutdown does not wait on explicitly.

## Verification

**Commands:**
- `pnpm run check` -- passes.
- `pnpm run test`, with `.env` present and again with it moved aside -- passes.
- `pnpm run test:integration` (postgres, mailpit and migrate only), `pnpm run test:e2e`, `pnpm run auth:schema:check`, and the `test:compose` stack -- pass.

## Implementation Notes

- Sabotage, each run against `send-queued-email.integration.test.ts` and restored:
  - `for update skip locked` -> `for update`: first run passed (Postgres re-checks the quals after the wait, so correctness held and only blocking differed); added "skips a row another pass holds instead of waiting for it", which then failed under the sabotage.
  - `attempts` guard removed from the record: "lets a stale record change nothing and announce nothing" failed.
  - Drop of a missing source removed: "drops a delivery about a deleted window" failed.
- `queue-email-notifications.integration.test.ts` (6.6) now queues through `queueEmailNotificationCommand` instead of `runNotificationPass`, because a full pass now also sends what it queued and those tests read the ledger as the queue left it.
- The organization's name and slug are read with a new `organizationBySlugRepository.findById(tx, id)`. The first version read it on the global connection inside the claim callback, so a claim holding a row lock waited for a second pool connection; the main session moved it onto the claim's transaction (`"organization"` has no RLS, so the read is the same).
- A stale record first returned `none`, which the pass reads as "nothing due" and so dropped the organization from the rest of its rounds. The main session added the outcome `stale`, which keeps the organization in the rounds and is counted nowhere.

**Pass 2 (after review loopback 1).** Built from pass 1's stash with `git stash apply`; the stash stays until this pass is committed.
- `dispatchBudgetMs(intervalMs, overdueMs)` lives in `src/worker-dispatch-budget.ts`, re-exported by `worker.ts`, because a unit spec importing `@/worker` loads config and fails without `.env`.
- "At least one claim" counts claims that found work. Counting an empty claim would let an organization with nothing due use up a budget of 0 and starve the next one.
- The 6.6 test "records one organization's failure and carries on" now expects two errors for the bad organization: queueing, then dispatch, which visits it as the Boundaries require.
- The main session moved the budget clock to the start of the pass, as the Boundaries say; the sub-agent had started it after queueing.
- Sabotage repeated in pass 2: plain `for no key update` (no `skip locked`) fails "skips a row another pass holds instead of waiting for it". The `attempts` guard and the deleted-window drop are unchanged from pass 1.
- WSL clock: in the sub-agent's first full integration run, "summarises transient failures in one warn line, with no address anywhere" and a 6.6 test failed once. Both then passed in two full runs and three file-only runs, and the main session's full run passed 814/814. A row is due at the queue transaction's `now()`, and this machine's clock steps back up to 1.4 s (AGENTS.md), so a claim right after queueing can briefly see it as not yet due. In production such a row is claimed on the next pass.

**Verification (main session, 2026-10-22, pass 2).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (535 modules).
- `pnpm run test`: 458/458 with `.env`, and again with it moved aside.
- `pnpm run test:integration` (postgres and mailpit up; migrate had exited): 814/814.

**Verification (main session, 2026-10-22, after the review pass 2 patches).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (534 modules).
- `pnpm run test`: 458/458 with `.env`, and again with it moved aside.
- `pnpm run test:integration` (postgres and mailpit only): 818/818.
- `pnpm run test:e2e`: 10 scenarios, 86 steps pass. `pnpm run auth:schema:check`: in sync.
- The `test:compose` backplane stack: 2/2, then `down -v`.

## Spec Change Log

1. Review pass 1, intent_gap (Triage Log 1 and 2). The frozen Budget said both "a pass plus one send completes inside the health limit" and "it always runs at least one round", which contradict with more than one organization and a stalled SMTP server. The owner decided the time limit wins: the budget is checked before every claim, a pass makes at least one claim, and the starting organization rotates per pass. Amended: the frozen Budget bullet (owner's decision), the Tasks, which now also carry the pass 1 patch findings (3 to 15). Known-bad state avoided: one round of K organizations × 45 s overrunning `WORKER_PASS_OVERDUE_MS`. KEEP from pass 1: the claim, lease and guarded-record design in `send-queued-email.handler.ts` and `delivery.repository.ts`; the drop and abandon-at-claim paths; `findById(tx, …)`; the `stale` outcome; `notification-email.ts` and its wording; `retry-delay.ts`; the env settings and `assertRetryDelays`; the 17 tests in `send-queued-email.integration.test.ts`, including "skips a row another pass holds instead of waiting for it"; the 6.6 suite's queue-only `pass` helper.

## Review Triage Log

Pass 1 (blind hunter, edge case hunter, verification gap; same model as the session).

1. medium, intent_gap — the dispatch budget is checked only between rounds, so one round over K organizations with a stalled SMTP server takes K × 45 s and can turn health red (all three layers). `worker.ts:453` `if (round > 0 && …) break`. The frozen Boundaries say both "a pass plus one 45 s send still completes inside the health limit" and "It always runs at least one round", which contradict once K > 1. Includes the edge case hunter's "rows of later organizations are leased after the budget" (same cause).
2. low, intent_gap (with 1) — the budget is silently 0 when `WORKER_PASS_OVERDUE_MS − interval < 55 s`, and the 55 s is not tied to `SMTP_TIMEOUTS` (blind hunter; edge case hunter). Its fix depends on the answer to 1.
3. medium, patch — an organization whose queueing throws is left out of dispatch, so its already-queued rows are never sent while queueing keeps failing (blind hunter; edge case hunter). `worker.ts` `active = orgIds.filter(… !failed.has …)`.
4. low, patch — the per-pass `warn` counts abandoned rows under "they will be retried", and permanent diagnostics are logged nowhere (blind hunter; edge case hunter).
5. low, patch — `record` uses `coalesce(lastError, last_error)`, so the `null` the handler passes for `sent` does not clear it; the code reads as if it does (blind hunter; edge case hunter).
6. low, patch — `claimDue` locks `for update`; AGENTS.md says `for no key update` to write, and the claim changes no key (blind hunter).
7. low, patch — the integration test header maps the `skip locked` sabotage to the test that passed under it, and misnames the stale-record test (blind hunter; edge case hunter).
8. low, patch — the incident-update integration test asserts only the subject; status, message and posted time from `sourceContent` are unchecked, so reading the incident's status instead of the entry's would pass (blind hunter; verification gap 6).
9. medium, patch — the dispatch loop's round-robin, its handling of `stale`, a throwing send command, and "every organization failed" in dispatch have no pass-level test (blind hunter; verification gap 3 and 4).
10. low, patch — `dispatchBudgetMs()` is unexported and its formula untested (verification gap 5). Its shape depends on 1.
11. low, patch — nothing proves `env.ts` runs `assertRetryDelays` at boot; `subscribe-limits.integration.test.ts` is the precedent (verification gap 1).
12. low, patch — no test follows the emailed unsubscribe link; swapping slug and id would pass (verification gap 7, filed defer). One `app.inject` closes it here.
13. low, patch — abandoning at claim leaves `last_error` null, indistinguishable from a run of transient failures; set a fixed diagnostic such as `EUNRECORDED` (blind hunter).
14. low, patch — `NOTIFICATION_RETRY_MAX_DELAY_SECONDS` schema minimum is 1, though the cross-check needs at least the base (≥ 60) (blind hunter).
15. low, patch — an unclear comment in the transient-retry test ("Not yet due before makeDue …") (blind hunter).
16. low, defer — the `startWorker` wiring of `stopClaiming.abort()` is untested; a spawned worker cannot stub `send`, so it needs a stalling SMTP endpoint in the lifecycle harness (verification gap 2, filed defer).
17. low, defer — throughput is one send at a time across every organization, a new SMTP connection each, about one interval per pass; a large subscriber list takes hours (blind hunter). Not stated as a limit anywhere.
18. low, reject — a retried "scheduled" email can arrive after the same window's "started" or "completed" one, worded from current rows (blind hunter). At-least-once with retries never promised order; preventing it needs cross-row logic.
19. false — a change that stops being public between queueing and claim is still sent (edge case hunter). DOMAIN NotificationDelivery applies the rule when the delivery is created.
20. false — an edit between queueing and sending goes out unjudged (blind hunter). The frozen Boundaries say content is read from current rows at claim, and DOMAIN judges at creation.
21. low, reject — `completedAt ?? scheduledEndAt` could print a completion time never recorded (edge case hunter). A `maintenance_completed` delivery is created only from a non-null `completed_at`, and nothing clears it.
22. false — the transient-summary test depends on the env budget (edge case hunter). Neither `.env` nor CI sets the intervals, so the default budget is 30 s against millisecond stub sends.
23. low, reject — `DeliveryRecord` allows nonsense combinations (blind hunter). One caller, all paths tested; a status-keyed union adds types with no named harm.
24. false — the spec says `in-review` while sprint status says `in-progress` (blind hunter). The workflow moves sprint status at presentation.

Pass 2 (blind hunter, edge case hunter, verification gap; same model as the session). No intent gap or bad spec.

25. low, patch — abandon-at-claim returns no diagnostic, so rows given up after crashes never reach the per-pass `warn` (blind hunter). Return `diagnostic: 'EUNRECORDED'` from that path.
26. low, patch — the `diagnostic` doc comment on `SendQueuedEmailCommandResult` leaves out `failed` (blind hunter; verification gap).
27. low, patch — the zero-budget start-up `warn` says one email per pass, but `worked` counts drops and stale claims too (blind hunter). Word it as one claim per pass.
28. low, patch — `worker.ts` re-exports `dispatchBudgetMs` and nothing imports it; it is a second path back to the config-loading import (blind hunter).
29. low, patch — `retry-delays.integration.test.ts` is a third copy of the spawn harness; the Task allowed an `it` in `subscribe-limits.integration.test.ts` (blind hunter).
30. medium, patch — no pass-level test that `stale` keeps the organization in the rounds; treating it like `none` passes every test (blind hunter; verification gap).
31. low, patch — the per-pass summary test covers only `retrying`; `failed` and `abandoned` groups are unpinned (blind hunter; verification gap).
32. medium, patch — no test observes round-robin within one budgeted pass; draining each organization in turn passes every test (verification gap).
33. low, patch — the wait assertions have no slack for this machine's backwards clock steps (edge case hunter).
34. low, defer — nothing pins that the budget clock starts before queueing (blind hunter; verification gap, filed defer). Needs slow queueing in a concurrent suite.
35. low, defer — the zero-budget start-up `warn` is untested (verification gap, filed defer); belongs with Triage 16's lifecycle harness.
36. low, defer — keeping an earlier `last_error` on `sent` and on abandon-at-claim is unpinned (verification gap, filed defer). Nothing reads `last_error` yet.
37. low, reject — the lease minimum (60 s) equals overall plus socket with no margin (blind hunter). The record runs once `send` resolves at the 45 s deadline, 15 s inside the lease; a reply trickling past the deadline is the accepted at-least-once duplicate.
38. low, reject — a row abandoned at claim keeps an earlier diagnostic instead of `EUNRECORDED` (blind hunter). The Task says "when it is null"; Triage 25 makes the path visible in the log.
39. low, reject — `claimDue` uses `for no key update skip locked` while the frozen Boundaries, epics and ARCHITECTURE 5.6 say `for update skip locked` (blind hunter). Same claim with the weaker row lock AGENTS.md asks for; nothing references `notification_deliveries`, so behaviour is identical. Raised with the owner for the ARCHITECTURE wording.
40. false — an unsubscribe after the claim still gets the email (edge case hunter). Accepted in Design Notes.
41. low, reject — an accepted send whose record misses leaves no count or event (edge case hunter). Same accepted case; a re-read before send would narrow it, not close it.
42. carried false — a source made non-public between queueing and sending (edge case hunter). Triage 19.
43. carried false — a zero budget lets one slow send overrun health (edge case hunter). Owner's decision, with the start-up warning.
44. low, reject — the budget is not checked while `worked` is 0 (edge case hunter). Only `none` and throwing claims skip it, and each visits an organization once, then leaves the rounds.
45. low, reject — shutdown waits for queueing to finish (edge case hunter). Queueing is one short transaction per organization; a guard adds a branch for a rare, bounded delay.
46. carried false — the summary test depends on the env budget (edge case hunter). Triage 22.
47. false — duplicate `orgIds` make "every organization failed" resolve (edge case hunter). Discovery returns distinct ids, and only tests pass `orgIds`.
48. low, reject — the integration test keeps its own subscriber insert and hand-builds the transition request (blind hunter). Test-only duplication; the fix widens shared fixtures.
