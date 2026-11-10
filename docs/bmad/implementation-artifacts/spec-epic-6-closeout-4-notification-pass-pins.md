---
title: 'Epic 6 close-out PR 4 — pin four notification-pass behaviours'
type: 'chore'
created: '2026-11-10'
status: 'done'
baseline_commit: '6265513f7f537020c52bf16a6c7d0f78aec6c9c8'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Four behaviours of the notification pass are deliberate, but no test holds any of them, so a one-line change to each passes every suite. They come from deferred-work.md: "From Story 6.7", entries 2 and 4, and "From Story 6.9", entries 1 and 2. The owner grouped them into one PR.

**Approach:** Tests only, with no production change. Each test must fail under its named sabotage, and every wait in it is bounded.

1. **Budget from pass start** (`src/worker.ts:417`, check at :488). Add a test to `src/modules/notification/send-queued-email.integration.test.ts`, using its `stubSend`, `newOrg`, `subscribe`, `scheduleMaintenance` and `deliveries` helpers.
   - Setup: an org with 3 owed deliveries, queued first with `queueEmailNotificationCommand`. Instant sends.
   - Hold the org's `notification_cursors` row with `holdTransaction` (`src/shared/testing/locks.ts`) and `select … for update`. Start `runNotificationPass(app, logger, { orgIds: [org], dispatchBudgetMs: 1_000 })` without awaiting it.
   - Use `waitUntilBlockedBy` to confirm the pass is blocked in `lockForPass`, then commit after about 1.5 s and await the pass.
   - Expect exactly one `sent`.
   - Sabotage: move `const started` below the queueing loop. All three are sent.
2. **`last_error` is kept** (`delivery.repository.ts`: `record` :219, `abandon` :182). Decided: pin, do not change. DOMAIN leaves it unspecified, nothing reads it, and keeping the previous diagnostic records why a delivery needed retries.
   - Add two tests to the same file:
     - A delivery that fails transiently, then succeeds on a later claim, ends `sent` with the first failure's `last_error`.
     - A row that already has a `last_error`, claimed at `attempts >= maxAttempts`, is abandoned with that `last_error`, not `EUNRECORDED`.
   - Reuse the file's existing abandon-at-claim setup (about :422).
   - Sabotage: each `coalesce` made a plain assignment.
3. **Env mapping.** A new file, `src/config/notification-env-mapping.integration.test.ts`.
   - Before any import of `@/config`, set `process.env.NOTIFICATION_RETENTION_DAYS = '11'` and `SUBSCRIBER_PENDING_GRACE_DAYS = '22'`. Then `await import('@/config/env')` and assert `notification.retentionDays === 11` and `subscribe.pendingGraceDays === 22`.
   - This works because `node --test` runs each file in its own process, and dotenv does not override variables already set.
   - Sabotage: swap the two fields in `src/config/env.ts:170,179`.
4. **`requestConfirmation`'s retry** (`subscriber.repository.ts:182-240`). Add a test to the file that already tests the repository or `create-subscriber`.
   - Seed a committed subscriber for an address.
   - Call `requestConfirmation` inside `withTenantTransaction` with a `TenantTransaction` whose `sql` forwards to the real one. Right after the first `insert into subscribers` statement resolves, it deletes that row on the same transaction.
   - Expect the second iteration's insert, and its normal result.
   - Sabotage: `continue` → `break`, and `continue` → `return` or throw.
5. Mark the four entries RESOLVED in `deferred-work.md`, each naming its test.

</frozen-after-approval>

## Implementation Notes

- Files touched:
  - `src/modules/notification/send-queued-email.integration.test.ts`: three tests (budget, and two for `last_error`).
  - `src/modules/notification/create-subscriber.integration.test.ts`: the retry test.
  - `src/config/notification-env-mapping.integration.test.ts`: new. After review, it reads the config in a spawned process, as the other `src/config` suites do. The first version's dynamic `import('@/config/env')` failed `tsc` (TS2307 under `nodenext` in a CommonJS package) and depended on per-file process isolation.
  - `docs/bmad/implementation-artifacts/deferred-work.md`: four RESOLVED notes.
  - No production code.
- The implementing agent was cut off by a session restart before it ran sabotages or wrote notes. The orchestrator reviewed its diff, wrote the deferred-work notes, and ran everything below.
- After the restart, Postgres and Mailpit were down (sign-up answered 500 with `ECONNREFUSED`), so the first file runs failed. `docker compose up -d --wait` fixed that, and every file passed.
- The retry test's forwarding `sql` is a `Proxy` over the real handle. It adds a `delete` on the same transaction right after the first `insert into subscribers` resolves, which leaves the same visible state a prune committed between the two statements would.
- **Sabotages, run by the orchestrator; each failed the named test:**
  - `const started` moved below the queueing loop: budget test, with `[sent, sent, sent]`.
  - `record`'s `coalesce` made a plain assignment: "keeps the earlier failure's last_error".
  - `abandon`'s `coalesce` made `'EUNRECORDED'`: "keeps a recorded last_error".
  - `retentionDays` mapped from `SUBSCRIBER_PENDING_GRACE_DAYS`: the mapping test.
  - `if (!row) continue` → `break`, and → `return { …, outcome: 'unchanged' }`: the retry test.
- One run of the moved-`started` sabotage ended with `[pending, pending, pending]` instead of `[sent, sent, sent]`. The test still failed, and a rerun showed `[sent, sent, sent]`. The clean budget test then passed 3 of 3 runs alone. The cause of the one-off is unknown.
- **Verification after the review patches:**
  - The three files alone: 28/28, 18/18 and 1/1.
  - `pnpm run check`: pass.
  - `pnpm run test:integration`: 881/881. It had also passed 881/881 before the patches.
  - Unit tests with `.env` moved aside: 478/478.
  - `pnpm run test:e2e`: 12/12 scenarios.
  - The only earlier failures came from the stopped Docker services (noted above). No test failed on its own merits.

## Review Triage Log

Blind Hunter (session model), one pass:

1. The abandon test asserts only `outcome`, while the result says `EUNRECORDED` and the row keeps `ETIMEDOUT`. **low.** Patched: the test asserts the whole result and comments on the split, which is coherent. The summary counts why the pass gave up, and the row keeps the transport's diagnostic.
2. The "pin as is" decision is not recorded in DOMAIN. **low, rejected.** DOMAIN describes `last_error` as a transport diagnostic and does not say when it is cleared. Pinning existing behaviour changes no decision, and nothing reads the column.
3. The other `env.ts` mappings are left untracked. **low.** Patched: a new entry under "Aimed at Epic 8".
4. The budget test could leave its pass running after a failed wait. **low.** Patched: `finally` awaits the pass with its rejection swallowed.
5. The headers don't list the new sabotages, and the retry test sits under the Story 6.3 `describe` with no context. **low.** Patched: the sabotage list, plus a comment on the retry test.
6. "As a concurrent prune would" doesn't match the seeded row. **low.** Patched: the comment now describes what the same-transaction delete simulates.
7. The retry test doesn't check what the second insert wrote. **low.** Patched: it asserts the retry's token hash and a future expiry.
8. The abandon test repeats setup and hard-codes 8. **low.** Patched: it uses `setDelivery`. 8 stays, as in the neighbouring abandon test.
9. The env test doesn't say why it is an integration test, and depends on process isolation. **medium.** Patched: rewritten to spawn a process, with a header explaining why.
10. The spec has no verification record and a stale status. **low.** Patched: verification is listed above, and the status is set to `done`.
11. "Its own queueing is quick" contradicts the hold. **low.** Patched: the comment is reworded.
