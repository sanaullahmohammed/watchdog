---
title: 'Epic 6 close-out PR 3 — test the worker shutdown and dispatch-budget wiring'
type: 'chore'
created: '2026-11-10'
status: 'done'
baseline_commit: 'e25a296d9955fdcd11ac5e1128f03a845b1f089c'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Two pieces of `startWorker` (`src/worker.ts:633-753`) run only in a spawned worker, and no test covers either of them (deferred-work, "From Story 6.7", entries 1 and 3):
- `shutdown` aborts `stopClaiming` first and then awaits the notification pass in flight. Dropping the `stopClaiming.abort()` call, or the wait, fails no test.
- The start-up `warn` "WORKER_PASS_OVERDUE_MS leaves no time beside NOTIFICATION_PASS_INTERVAL_MS for a send…" is logged when `dispatchBudgetMs(...) === 0`. Inverting that check, or dropping the warn, fails no test.

**Approach:** Test only. No production code changes. Add tests to `src/worker-lifecycle.integration.test.ts`, using its existing `spawnScopedWorker` harness (`src/shared/testing/worker-process.ts`), which scopes every loop to the test's own organizations.

1. **Shutdown during a send.**
   - Set up one new org, one confirmed subscriber, and two scheduled maintenance windows. Follow the recipe in `src/modules/notification/send-queued-email.integration.test.ts`: `signUpWithOrg`, a raw confirmed `subscribers` insert inside `withTenantTransaction`, and `scheduleMaintenance` twice. The worker's own pass queues the deliveries.
   - Point the child at `startSmtpStub({ replyDelayMs })` from `src/shared/testing/smtp-stub.ts` via `SMTP_HOST=127.0.0.1` and `SMTP_PORT=<stub port>`, so each send is slow but accepted.
   - The child's `WORKER_PASS_OVERDUE_MS` must give a dispatch budget above 0, for example 120000 with a 1000 ms interval. The budget-0 env that `childEnv(path, 20_000)` gives would stop dispatch after one send anyway, and the test would prove nothing.
   - When the stub has received `DATA`, send SIGTERM. Then assert:
     - The child exits 0.
     - The output contains `waiting for the notification pass in flight`.
     - The org's two deliveries are exactly one `sent` with 1 attempt and one `pending` with 0 attempts.
     - The stub saw exactly one `MAIL FROM`.
     - The output has no budget-0 warn line.
2. **The budget-0 warn.** Spawn a child whose env gives a budget of 0 (`childEnv(path, 20_000)` does). Once its first heartbeat lands, assert the output holds a JSON log line with `"level":40` and that exact message. Test 1's child supplies the negative case, so an inverted check fails one test or the other.
3. **Close the entries.** Mark the two entries in `docs/bmad/implementation-artifacts/deferred-work.md` RESOLVED, each naming its test.

Every wait is bounded and fails instead of hanging. Use `waitFor`, `exitWithin`, and a per-test `timeout`. The stub is closed in an `after` or `finally`.

</frozen-after-approval>

## Implementation Notes

- Files touched: `src/worker-lifecycle.integration.test.ts` (a nested `describe` "Story 6.7: shutdown and the dispatch budget in a spawned worker" with two tests) and `docs/bmad/implementation-artifacts/deferred-work.md` (two RESOLVED notes). No production code.
- **Correction to the Intent's example.** "120000 with a 1000 ms interval" gives a dispatch budget of min(1000, 64000) = 1 s (`dispatchBudgetMs` caps it at one interval). That would end the pass after one send whether or not shutdown aborts, so the first version of the test passed with `stopClaiming.abort()` removed. The test now sets `NOTIFICATION_PASS_INTERVAL_MS=30000` beside overdue 120000 (budget 30 s), and asserts `dispatchBudgetMs(30_000, 120_000) >= 20_000`, so a later formula change cannot quietly empty the test.
- **Deviation: the budget-0 test waits for `"msg":"Worker is ready"`, not the first heartbeat.** The heartbeat file can land before the child's stdout reaches the parent, and one run read the output with only the Swagger line in it.
- Shutdown test: `replyDelayMs` is 2000, so a send takes about 14 s and leaves about 4 s between the stub's `DATA` and the record. The test asserts exit 0, `waiting for the notification pass in flight`, no budget-0 warn, no `"level":50` line, deliveries exactly `pending:0` and `sent:1`, and one `MAIL FROM`. The budget-0 test compares the whole message.
- **Sabotages, run by the orchestrator after the fixes; each failed the named test:**
  - `stopClaiming.abort()` removed: shutdown test, with `[sent:1, sent:1]`.
  - The `await Promise.all(inFlight…)` wait removed: shutdown test, on a `"level":50` line. Before the error-line assertion it failed on `[pending:0, pending:1]`.
  - `=== 0` inverted: both tests. The shutdown test saw the warn, and the budget-0 test did not.
  - Warn logged at `info`: budget-0 test, with level 30.

## Review Triage Log

Blind Hunter (session model), one pass:

1. The budget precondition is hand-worked in a comment. **medium.** Patched: an assertion on `dispatchBudgetMs`.
2. SIGTERM's window after `DATA` is about 2 s, and the comment said the body had arrived. **medium.** Patched: `replyDelayMs` is 2000 (about 4 s window), and the comment is reworded.
3. No check that shutdown logged no error. **low.** Patched: no `"level":50` line. Cheap, and it turned the no-wait sabotage into a direct failure.
4. The warn was matched by prefix. **low.** Patched: an exact `BUDGET_ZERO_WARNING` comparison.
5. The notes said "after the first heartbeat". **low.** Patched: the deviation is recorded above.
6. "Surprises: none" hid the Intent's wrong example. **medium.** Patched: the correction is recorded above.
7. No record of the sabotages. **low.** Patched: listed above.
8. The spec says in-progress while deferred-work says RESOLVED. **false.** Finalizing sets `done` before the commit, so both land together.
9. The new tests sat under the "Story 5.9" `describe`. **low.** Patched: a nested Story 6.7 `describe`.
10. The child is left running if the `DATA` wait times out. **low, rejected.** The file's `after` hook SIGKILLs every child, and the worker is scoped to its own org, so the harm is only a few idle seconds on a run that has already failed.
