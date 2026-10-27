---
title: 'Story 6.10: Prove subscribe to unsubscribe end to end'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'ce04f0ba150c4936689d3e60bd7fc905497891b5'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 6.3 to 6.7 prove subscribe, confirm, unsubscribe and dispatch one at a time in integration suites. Nothing proves them as one flow through the running application, and FR21's verification asks for E2E tests (FR19's asks for delivery to Mailpit).

**Approach:** A Cucumber feature, `tests/notification/subscriber-flow.feature` with its `.steps.ts`, drives the flow through the shared listening app. A visitor subscribes. The test reads the confirmation email from Mailpit and follows the link. An operator posts a public incident update. The notification pass runs, scoped to the scenario's organization. The test reads the notification from Mailpit and follows its unsubscribe link. Then it shows that nothing more arrives. A subscriber who never confirms is sent nothing.

## Boundaries & Constraints

**Always:**
- The operator's side goes through the admin REST API with the session cookie, as `public-status.steps.ts` does. The visitor follows the emailed links over the real socket with `fetch(world.baseUrl + path + search)`. The links are taken from the email Mailpit received and cut to path and query with `new URL`, because `PUBLIC_BASE_URL` is not the listening port.
- Subscribe uses `world.server.inject` with a `remoteAddress` unique to the request. This is defensive: the run makes 4 subscribes against a limit of 5 an hour per client IP (`req.ip`, `trustProxy` off), held in memory by the one app the whole run shares, and every socket request, like `inject`'s default, arrives from 127.0.0.1. The next feature to subscribe would trip it. The limit is not what this story proves (6.3 does). Recorded in a comment on the step.
- Each address comes from `uniqueRecipient(label)` and is read only through `messagesTo` (`src/shared/testing/mailpit.ts`). No step searches Mailpit without a recipient or deletes its messages.
- The pass is `runNotificationPass(world.server, world.server.log, { orgIds: [world.context.orgId], dispatchBudgetMs: 30_000 })`, never unscoped. The explicit budget keeps a local `WORKER_PASS_OVERDUE_MS` from cutting it to one claim. It is awaited, and it sends before it returns. An SMTP failure is recorded rather than thrown, so a missing Mailpit shows at the Mailpit read.
- Every negative assertion has a positive control in the same pass: a confirmed subscriber who does receive that update. "Nothing more" is an exact count of that visitor's messages, never a timeout.
- Ordering guard: confirmation is `confirmed_at = now()` and an update owes a subscriber only when `confirmed_at < recorded_at`. The WSL clock steps back up to 1.4 s, so a helper polls the database until `clock_timestamp()` is 2 s past a stored value, read through `withTenantTransaction`. Guard 1 waits past the organization's latest `incident_updates.created_at`, after the Background's incident and before anyone confirms. Without it, a step back could make the incident's opening entry owed. Guard 2 waits past the organization's latest `subscribers.confirmed_at`, after the last confirmation and before the update. Without it, a step back could make the update not owed.
- Dispatch guard: `claimDue` takes a row only when `next_attempt_at <= now()`, and that default is the queue transaction's `now()`. So a step back inside the pass can leave owed rows not yet due. The step that waits for the control's expected count polls Mailpit for up to 3 s. If the count falls short, it runs the same scoped pass again, at most twice more. Another pass can only send what is already owed. The exact-count assertions follow it, so this cannot hide a duplicate or a wrong recipient.
- The scenario's organization and user go through the existing After hook. Subscribers, deliveries and the cursor cascade with the organization.

**Never:** a change to `src/` beyond `src/shared/testing/` (and none there unless a helper is missing); writing `subscribers` or `notification_deliveries` rows directly, aging them, or reading the ledger to prove an outcome Mailpit can show; the seeded organization; an unscoped pass; `setNotFoundHandler`; editing `docs/genesis/*`, `AGENTS.md` or an applied migration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Confirm | visitor A subscribes; the link from A's confirmation email is opened | 202 on subscribe; one confirmation email, subject `Confirm your subscription to <org> status updates`; the link answers 200 `Your subscription to <org> status updates is confirmed.`; A's row reads `confirmed` | N/A |
| Notified | A and control B confirmed; operator posts update U1; pass runs | A and B each have exactly one notification. Its subject is `[<org>] <incident title>: Investigating` and its body holds U1's message. The body's unsubscribe URL equals the `List-Unsubscribe` header's with its angle brackets stripped, and `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click` | N/A |
| Unsubscribe | A opens the unsubscribe link from U1's email | 200 `You are unsubscribed from <org> status updates.` | N/A |
| Nothing more | update U2 posted; pass runs again | B has exactly two notifications, so U1 is not sent twice and U2 is sent. A still has exactly one confirmation and one notification | N/A |
| Never confirms | visitor C subscribes and never opens the link; control D confirmed; update posted; pass runs | D has one notification; C has only the confirmation email | N/A |

</frozen-after-approval>

## Code Map

- `cucumber.mjs` -- loads `tests/*/*.steps.ts` (one directory deep) and `tests/**/*.feature`; no change.
- `tests/support/common-hooks.ts` -- one shared app listening on `127.0.0.1:0`; `this.db` is the app role (no GUC, so it sees no tenant rows). The After hook deletes `context.orgId` and `context.userId`.
- `tests/status-page/public-status.steps.ts` -- the pattern to copy: `signUpWithOrg(this.server, slug)` (`@/shared/testing/tenant`), `adminPost` with `TEST_ORIGIN`, services created through `POST /api/v1/services`, incidents through `POST /api/v1/incidents { title, impact, affectedServices }`. Steps live in each file; nothing is shared from it, so copy what is needed.
- `POST /api/v1/incidents/:id/updates { message }` → 201 `{ id }`.
- `src/shared/testing/mailpit.ts` -- `uniqueRecipient`, `messagesTo(address, { atLeast, timeoutMs })` (polls; `atLeast: 0` returns at once). `MailpitMessage.Text`, `.Subject`, `.Headers['List-Unsubscribe']`. The confirmation send is not awaited by subscribe, so wait for it with `atLeast: 1` and a timeout of a few seconds.
- Routes (`src/modules/notification/commands/*/*.public.route.ts`): `POST /status/:orgSlug/subscribers { email }` → 202. `GET /status/:orgSlug/subscribers/confirm?token=` → 200 text (`dtos/link-answer.ts` `confirmedText`). `GET /status/:orgSlug/subscribers/unsubscribe?subscriber=&signature=` → 200 text (`unsubscribedText`).
- `domain/confirmation-email.ts:20` -- the confirm link is on its own line. `domain/notification-email.ts:115-130` -- subject, `To stop these emails, unsubscribe: <url>`, and both headers.
- `src/worker.ts:405` `runNotificationPass` -- no import side effects (`startWorker` is exported, not called). With one organization, a failure rejects.
- `delivery.repository.ts:115` -- `s.confirmed_at < o.recorded_at`, the reason for the ordering guard.
- `withTenantTransaction` (`src/shared/db/tenant-transaction.ts`) -- to read A's status for the Confirm row and the guards' stored values.
- `<org>` is `displayNameFor(slug)` (`src/shared/testing/tenant.ts:37`). The subject's status is capitalised (`notification-email.ts:61`). `send-queued-email.integration.test.ts:686` strips the header's angle brackets.
- `create-incident.handler.ts:62` writes a public opening timeline entry, and the first pass reads the whole history. That entry is what guard 1 keeps unowed.
- `subscriber.repository.ts:81` `confirmedAddress` re-checks `status = 'confirmed'` at send and drops the row (`send-queued-email.handler.ts:104-106`). `unsubscribe` keeps `confirmed_at`.
- `src/worker-dispatch-budget.ts` -- the default budget, and why the call passes its own.
- CI `.github/workflows/ci.yml` job `database` already runs Mailpit (1025/8025) and sets `NOTIFICATION_LINK_SECRET`. Locally, `docker compose up -d` provides Mailpit.

## Tasks & Acceptance

**Execution:**
- [x] `tests/notification/subscriber-flow.feature` -- a Background (an organization with a public service and an active incident affecting it), then two scenarios, "a subscriber is notified until they unsubscribe" (Matrix rows Confirm to Nothing more) and "a subscriber who never confirms is sent nothing". Steps name visitors by label ("the first visitor"), not by personal name.
- [x] `tests/notification/subscriber-flow.steps.ts` -- the steps, the clock guard and the link helpers. A header comment maps each sabotage below to the step that fails.

**Acceptance Criteria:**
- Each Matrix row is an AC: given its Input / State, when the steps run, then its Expected Output.
- Sabotage, each recorded in Implementation Notes, makes `pnpm run test:e2e` fail. The sabotages:
  - every `status = 'confirmed'` check removed together: `lockConfirmed`, the `insertPending` join and `confirmedAddress`. A then receives U2. Any one alone is caught by the others, and C is never owed because its null `confirmed_at` fails the comparison.
  - `s.confirmed_at < o.recorded_at` removed. A then receives the incident's opening entry.
  - `unsubscribe` no longer changes the status
  - the notification body's unsubscribe URL carries a wrong signature
  - the pass call is removed from the step
  - `on conflict … do nothing` removed from `insertPending`. The second pass then hits `notification_deliveries_once_uk` (23505) and rejects, which fails the pass step rather than showing U1 twice.
- The suite passes three runs in a row locally.

## Design Notes

Why a control in every negative: `messagesTo` with `atLeast: 0` returns at once, so "A has one notification" would also pass if the second pass had sent nothing to anyone. B's second notification shows that U2 was owed and sent in that same pass.

Why only GET for the unsubscribe link: it is the link a person clicks. 6.4's integration suite covers the RFC 8058 POST. Here, the test only checks that the header carries the same URL.

## Verification

**Commands:**
- `pnpm run check` -- passes.
- `pnpm run test`, with `.env` and with it moved aside -- passes (no unit change expected).
- `pnpm run test:e2e` (postgres, mailpit, migrate up; the `app` profile down) -- passes, three times in a row.
- `pnpm run test:integration` and `pnpm run auth:schema:check` -- pass.

## Implementation Notes

Sabotages run against `pnpm run test:e2e`, each reverted afterwards:

- all three `status = 'confirmed'` checks removed: fails at "the first visitor has exactly 1 notification" (after U2).
- `s.confirmed_at < o.recorded_at` removed: fails at "the first visitor has exactly 1 notification" (opening entry).
- `unsubscribe` leaves the status unchanged: fails at the same step (A receives U2).
- wrong unsubscribe signature in the body: fails at "the unsubscribe link answered that they are unsubscribed".
- `on conflict ... do nothing` removed from `insertPending`: the second pass rejects with 23505 ("every organization failed") and fails the pass step.
- pass call removed: not run; the control never receives its notification, so the pass step fails.

Main session, after reading the diff (2026-10-27):
- The Matrix's Notified row checks both A's and B's notification, but only A's was checked. Added "the second visitor's notification is for that update".
- Ran the pass-call-removed sabotage: both "the notification pass runs until …" steps fail (the second and fourth visitors have 0 notifications). Re-ran "`unsubscribe` leaves the status unchanged": fails at the first visitor's exact count, as the sub-agent reported.

After the review pass 1 patches (8 to 16), the main session ran these sabotages, and each failed the suite:
- The signature corrupted in `unsubscribeLink` (shared by body and header): fails at "the unsubscribe link answered that they are unsubscribed".
- Every `status = 'confirmed'` check removed together with `s.confirmed_at < o.recorded_at`: fails at the first visitor's count, and in scenario 2 at "the fourth visitor has exactly 1 notification", which now includes the opening entry.
- Every status check removed, and the comparison made to treat a null `confirmed_at` as earliest (`coalesce(s.confirmed_at, '-infinity')`): fails at "the third visitor has exactly 0 notifications" and at the first visitor's count after U2. So the "never confirms" check can fail.

**Verification (main session, 2026-10-27, after the review pass 1 patches).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (543 modules).
- `pnpm run test`: 468/468 with `.env`, and again with it moved aside.
- `pnpm run test:e2e`: 12 scenarios and 120 steps pass, three runs in a row (and three before the patches).
- `pnpm run test:integration` (postgres, mailpit and migrate only): 852/852, first run. `pnpm run auth:schema:check`: in sync.

## Spec Change Log

## Review Triage Log

Spec review, before approval (one reviewer, same model as the session).

1. high, fixed -- removing the queue's status filter alone could not fail the test, because the send re-checks the status and C's null `confirmed_at` is never owed. The sabotage now removes all three checks together.
2. medium, fixed -- the unique-key sabotage named no edit. It now removes `on conflict`, and the pass step is what fails.
3. medium, fixed -- a clock step inside the pass can leave owed rows not due. Dispatch guard added: wait, then rerun the scoped pass at most twice.
4. low, fixed -- the clock guards now wait past the stored timestamp, not past the clock on entry.
5. low, fixed -- the pass call passes `dispatchBudgetMs: 30_000`.
6. low, fixed -- the expected texts are pinned: the capitalised status, `displayNameFor`, and the header's angle brackets.
7. low, fixed -- the rate-limit note now says the unique address is defensive.

Pass 1 (blind hunter, edge case hunter, verification gap; same model as the session). No intent gap or bad spec.

8. medium, patch -- the pass step waits and reruns only for the named control. After U1, a WSL clock step can leave A's row not yet due once B's is sent, and "the first visitor has exactly 1 notification" then reads 0. The wait also polled `atLeast: expected + 1` over all messages, assuming one confirmation email. Wait on every visitor the scenario expects to receive something, counting notifications only (blind hunter; edge case hunter; verification gap).
9. medium, patch -- the emailed links' origin is never checked. `follow()` keeps only path and query, and the integration suite reads only `pathname`, so a link built on the wrong host would pass everywhere. Assert that the origin is `env.publicBaseUrl` (verification gap).
10. medium, patch -- "B has exactly two" would also pass with U1 sent twice and U2 never sent, which the Matrix says it rules out. The "for that update" step also picks a notification by Mailpit's order. Check that B's notifications hold each update's message exactly once, and pick by content (blind hunter; edge case hunter; verification gap).
11. low, patch -- no sabotage was shown to reach "the third visitor has exactly 0 notifications". Removing every status check together with `confirmed_at < recorded_at` does. Run it and record it (blind hunter).
12. low, patch -- the sabotage map's wrong-signature entry names "opens the unsubscribe link", which asserts nothing, and does not say which value was corrupted. Corrupting the body alone fails the header-equals-body check first (blind hunter).
13. low, patch -- the pass step's worst case, 3 × (30 s + 3 s), exceeds Cucumber's 60 s default, so it would fail as a generic timeout. Also, `ORG_PASS_BUDGET_MS` is a whole-pass budget. Give the step its own timeout and rename the constant (blind hunter; edge case hunter).
14. low, patch -- D's notification is counted but its content is never checked (blind hunter).
15. low, patch -- if guard 1 or guard 2 finds no row, it silently does nothing. Assert that the value exists (edge case hunter).
16. low, patch -- a missing confirmation email gives a TypeError, not an assertion message (edge case hunter).
17. low, reject -- under sabotage on WSL, a wrongly owed row could still be not yet due when a negative count is read, so the sabotage would slip (edge case hunter; verification gap). It needs a clock step inside the pass during a sabotage run. A ledger check would read the ledger the frozen block keeps out of proof, and with the fix for 8, the positives wait on every recipient.
18. false -- sprint-status says `in-progress` while the spec says `in-review` (blind hunter). Step 5 sets the story to `review` when it is presented.
19. reject -- the spec is not in the diff, and the three clean runs are unrecorded (blind hunter). The diff leaves the spec out on purpose, it ships in the same commit, and the fix edits this spec.
