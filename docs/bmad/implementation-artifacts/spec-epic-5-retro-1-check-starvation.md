---
title: 'One organization cannot stall every organization''s checks (Epic 5 retro item 1)'
type: 'bugfix'
created: '2026-10-18'
status: 'done'
baseline_commit: '704a2776cdb6649f9d6e58b64446e864d7b87113'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-retro-2026-10-17.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The monitor loop runs in rounds. Each tick awaits every organization's checks, and the next tick waits for the slowest one, so one organization with many slow targets delays every organization and turns the worker unhealthy (retro DR-1: a 481 s pass, a 16-minute first check). A check that waits for a slot also runs on the row it was listed with (DR-4, the queued window).

**Approach:** Owner's decision, 2026-10-18, recorded first in ARCHITECTURE 6.0.1. Each monitor tick queues every due monitor not already queued or running, through the existing round-robin limiter keyed by organization, and completes once its listings are done. Checks finish detached. "Never overlaps itself" becomes "never checks one monitor twice at once". A queued check re-reads its monitor when it gets a slot.

## Boundaries & Constraints

**Always:**
- **Edit ARCHITECTURE 6.0.1 before the code** (lines 498-510), dated 2026-10-18 (owner). It states the per-monitor rule, the stall rule, the lateness bound below, and that `WORKER_PASS_OVERDUE_MS` must exceed the longest check timeout (60 s) plus recording. This is documented, not enforced at boot, because tests use short values.
- **The registry.** A process-wide registry of queued and running monitor ids, beside `checkLimiter`, guarantees one check per monitor. An id is released in a `finally` on every outcome, including a `LimiterClosedError` before the task started. A monitor still registered is skipped by a later tick. A failed record leaves `last_checked_at` as it was, so the monitor is listed again on the next tick.
- **The tick.** It still rejects when discovery fails, or when every visited organization's listing fails (Epic 9 item 2). Listing stays parallel per organization, which is unchanged.
- **The stall rule.** The tick also rejects when work is unsettled and nothing has settled for `WORKER_PASS_OVERDUE_MS`. Work is unsettled when checks are queued or running, or a check has failed since the last settle.
  - Only a check that was recorded, or rightly skipped, counts as settled. A rightly skipped check is a re-read miss, or a record that finds the monitor gone (`NotFoundException`).
  - A check whose run or record otherwise rejected does not settle. Its failure stays pending, even after the registry empties, until a later check settles or a tick finds nothing due with the registry empty. So health turns red when nothing is saved for the window (owner, 2026-10-18, review pass 1 E4).
  - The rule is process-wide: health is red only when nothing at all is saved. A single organization whose records fail shows in the `error` logs, not in health.
  - The clock resets when the registry goes from empty to non-empty, unless a failure is pending.
  - The clock is monotonic (`performance.now()`, because the wall clock steps back on the WSL2 machine) and injectable for unit tests.
  - Once the limiter is closed for shutdown, the tick does not apply the stall rule.
  - Health therefore turns red within about 2 × `WORKER_PASS_OVERDUE_MS` of the last settled check. A backlog alone never turns it red.
- **Detached failures are logged.** A detached check that rejects is logged at `error` with `orgId` and `monitorId`. A `LimiterClosedError` is logged at `info`. Move `isLimiterClosed` beside `LimiterClosedError`. A skipped monitor logs at `debug` at most. Nothing becomes an unhandled rejection.
- **Re-read on admission.** In its own tenant transaction, a check re-reads its monitor with `findRunnable(tx, id, now)`, using the listing's `now` and `listDue`'s conditions: enabled, service not archived, still due. It then runs on the whole fresh row. A missing, disabled, archived or no-longer-due monitor is skipped: no result, no event, no error. Re-checking "due" closes the gap where an earlier check of the same monitor recorded and released between the listing and the queueing. This closes DR-4's queued window only. The window during a run stays as DR-4's original triage rows decided.
- **The two commands share one per-monitor path.**
  - The new `queue_due_checks` command (`{ orgId, now? }`) returns `{ queued, skipped }` once queueing is done.
  - `run_due_checks` keeps awaiting and aggregating its own checks. Its `checked` counts the checks it ran, and it does not await a monitor already registered by someone else.
- **Shutdown.**
  1. `checkLimiter.close()` drops queued checks; they stay due.
  2. Then await the in-flight tick, then the registry's `drain()`. `drain()` loops until the registry is empty and covers the record step.
  3. Then `clearInterval` and `closeWorker`, whose `app.close()` drains the bus.
- **The lateness bound for many organizations.** Fairness cannot help many organizations that each have a slow check: everyone waits about backlog ÷ `MONITOR_CHECK_CONCURRENCY` × timeout. That is capacity, raised by `MONITOR_CHECK_CONCURRENCY`, and it is documented, not fixed here (owner, 2026-10-18).
- **Tests.** Tests pass `{ orgIds }`. Worker-child tests also set `MONITOR_CHECK_CONCURRENCY` through `childEnv`, and use 1 s intervals and 1 s timeouts.
- **`deferred-work.md`.** Remove the first bullet under "From Story 5.9" (the monitor-loop entry) and keep the heading's `closeWorker` entry.

**Never:**
- No per-organization monitor cap, and no change to the default concurrency.
- No change to the maintenance loop or to `startLoop`'s single-flight.
- No migration.
- No other genesis or AGENTS.md edit (retro items 6 and 7 stay held).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Noisy neighbour | Scoped worker with cap 2, tick 1 s and overdue 4 s. Org A has 30 monitors on `/silent`, timeout 1 s, interval 60 s (a backlog of about 15 s). Org B's monitor is **created once `/silent` has had at least two hits** | B has a result while A has fewer than 30 results, counted in rows and not by `checked_at`, within a generous 10 s guard. The healthcheck exits 0 at a probe taken after the backlog has run longer than overdue | N/A |
| Fix reverted | The tick awaits every check again | The noisy-neighbour test fails | N/A |
| Already registered | A check outlasts its interval | Not queued again. One result per check; due again once recorded | N/A |
| Recorded meanwhile | A listing sees M due, then M's earlier check records and releases before M is queued | The re-read finds M not due and skips it; one result | N/A |
| Changed while queued | Disabled, service archived, or monitor deleted after queueing | Skipped: no result, no event, no error log | N/A |
| Edited while queued | Target changed after queueing | Checked against the new target | N/A |
| Stalled | The registry is non-empty and nothing has settled for the overdue window | Ticks reject, and health turns red within about 2 × overdue | Logged |
| Nothing saves | Every record rejects (e.g. `check_results` refuses inserts) for the overdue window, while listings succeed | Ticks reject (`monitor checks stalled`), and health turns red | Each failure logged with its ids |
| Record fails | One record rejects | Logged with ids; the others record; the monitor is re-listed next tick | Logged |
| SIGTERM | One `/silent` check running (timeout longer than the grace window of the test), several queued | The running one is recorded as a timeout failure; queued ones are dropped (`info`); no error lines; exit 0 | N/A |

</frozen-after-approval>

## Code Map

- `docs/genesis/ARCHITECTURE.md:498-510` -- 6.0.1. Bullets at 502 and 507 change. `:832` (worker healthcheck) also needs a sentence on the monitor loop's stall rule, because it says every loop follows the "could not do its work" rule.
- `src/modules/monitoring/checks/check-limiter.ts:27-45` -- the key served longest ago goes first; a never-served key has `lastServed` 0, and ties go in insertion order. Unchanged. Add `isLimiterClosed` here.
- `src/modules/monitoring/checks/check-registry.ts` (+ `check-registry.spec.ts`) -- the registry factory: ids, the settle clock, the pending-failure state, `drain()`, and a test-only `reset()`. Settle on the fulfilled path only (`recorded` or `skipped`), and release the id in `finally`. `process-check-limiter.ts` holds the process-wide `checkLimiter` and `checkRegistry`, and the limiter gains a `closed` getter.
- `src/modules/monitoring/checks/run-check.ts` and the adapters -- they return a failure outcome rather than throwing (`http-check.ts:232`, `tcp-check.ts:79`, `ssl-expiry-check.ts:165`), so timeouts, refusals and blocked targets record and settle. Unchanged.
- `src/modules/monitoring/commands/run-due-monitor-checks/run-due-monitor-checks.handler.ts` -- extract the shared per-monitor path and add `commands/queue-due-monitor-checks/` beside it. Handlers register through the slice like their siblings (`src/modules/monitoring/index.ts`).
- `src/modules/monitoring/database/monitor.repository.ts:70-89` -- `listDue`. Add `findRunnable(tx, id, now)`. Its due condition is one shared SQL fragment used by both, not a copy. `services` is already allowlisted.
- `src/worker.ts:242-308` -- `runMonitorPass`, its doc comment, and `isLimiterClosed` (moves out). `:329-336` -- the `startLoop` comment. `:437-470` -- shutdown.
- `src/config/env.ts:62-66`, `.env.example:51-53` -- the overdue comments that describe a pass covering `ceil(due/cap) × timeout`. They now describe the stall rule.
- `src/worker-lifecycle.integration.test.ts:242-290` -- proves three things: red on a hung pass, the skip log, and a check recorded on SIGTERM. Split it into the noisy-neighbour test, a stall test (a `/silent` monitor with a timeout above the overdue window, waiting about 2 × overdue), and the SIGTERM timeout-recorded test. `:293` and `:324` must keep passing. `:315` shows the `childEnv` concurrency override.
- `src/modules/monitoring/due-monitors.integration.test.ts` -- add the registry, re-read (disabled, archived, deleted) and edited-target cases, with `now` passed. Existing cases keep passing.
- `src/shared/testing/test-endpoints.ts` (`/silent`, `/hold`), `worker-process.ts`, `fixtures.ts` -- reuse these. A new helper goes here.
- `docs/bmad/implementation-artifacts/deferred-work.md:209-214` -- the first 5.9 bullet.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/ARCHITECTURE.md` -- the 6.0.1 rule (Always) -- the decision goes first
- [x] `src/modules/monitoring/checks/` -- the registry and `isLimiterClosed`, with unit tests for release on every outcome and for `drain()`
- [x] `src/modules/monitoring/database/monitor.repository.ts` -- `findRunnable`
- [x] `src/modules/monitoring/commands/` -- the shared path, `queue_due_checks`, and `run_due_checks` on the shared path
- [x] `src/worker.ts` -- the tick, the stall rule, the shutdown drain, and the comments
- [x] `src/config/env.ts`, `.env.example` -- the overdue comments
- [x] `src/worker-lifecycle.integration.test.ts`, `src/modules/monitoring/due-monitors.integration.test.ts` -- the matrix
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- the 5.9 bullet

**Acceptance Criteria:**
- Given the matrix rows, when the suites run, then each row has a test that passes, and the noisy-neighbour test is shown to fail with the old tick restored (a mutation check, recorded in Implementation Notes).
- Given the rest of the suites, when they run, then they pass. The only edits are the split of `worker-lifecycle…:242-290`, a registry `drain()` before the assertions at `:471` and `:480`, and the `:293` adjustment below.

### Test notes (from spec review rounds 1 and 2)

- **Exports and draining.** Export the registry's `drain()` from the monitoring checks module for tests. Every test that queues checks drains it before asserting and in `afterEach`, because the registry is process-wide.
- **Stall test.** Use a `waitFor` limit of 30 s or more, and assert a `lastCompletedAt` that stops advancing across two probes. Do not assert a wall-clock upper bound.
- **Unit tests.** Unit-test the stall predicate and the release-on-every-outcome rule with a fake clock.
- **`:293` (check in flight on SIGTERM).** Ticks no longer block one another, so drop its `lastStartedAt` unchanged assertion. Keep "no `/hold` request beyond the first".
- **SIGTERM matrix row.** `timeoutSeconds: 15`, `exitWithin` 60_000, `MONITOR_CHECK_CONCURRENCY: '1'`, and two or more monitors queued. The queued ones have zero `check_results` rows, and there is no `"level":50` line.
- **Logged failures.** Tests that assert logged failures build the app with a capturing logger, as `worker-lifecycle…:138-146` does.
- **Stall test.** Wait for `monitor checks stalled`, not the substring `monitor pass failed`, which the per-org listing failure also logs.
- **Noisy-neighbour health.** Probe health only after the backlog has run longer than `WORKER_PASS_OVERDUE_MS` (for example, once the noisy org has about 10 rows and still fewer than 30). Also assert that the monitor loop's `lastCompletedAt` advances between two reads. One probe inside the boot grace proves nothing (`worker-health.ts:91-92`).
- **Nothing-saves test.** In-process: `runMonitorPass` gains `options.overdueMs` (tests pass their own, like `orgIds`; the worker never does). Stub `checkResultRepository.append` to reject (as `check-result-partitions.integration.test.ts` stubs repositories), run ticks spaced past an `overdueMs` of about 1.5 s, and assert the rejection `monitor checks stalled`. In the unit spec: fail, empty, fail across ticks with the clock advancing, then `stalled()` is true; a recorded settle or an idle tick clears it. Tests call `checkRegistry.reset()` in `afterEach` as well as `drain()`.
- **Gone mid-run.** A record that throws `NotFoundException` counts as skipped (no error log), with a test.
- **SIGTERM tests.** With the limiter closed, the tick skips the stall rule, so no `monitor checks stalled` error appears at shutdown; assert no `"level":50` line.
- **Registry unit test.** Start `a`, advance past the window, start `b`, then assert `stalled()` is true: a start while the registry is non-empty must not reset the clock. Also cover a rejected task not resetting it.
- **Re-read test.** The blocker holds its slot on `/hold?delay=5000` or longer, not 1.5 s, so the edits land first on a slow machine. Skipped monitors are asserted to emit no monitor event, and the missing-monitor case passes `now`.
- **`isLimiterClosed`.** Remove its `AggregateError` branch, which has no caller; it takes a bare `LimiterClosedError` only.
- **ARCHITECTURE 6.0.1.** Lines 502 and 507 change. At 509, add that the registry is per process. `assertWorkerIntervals` enforces only overdue > interval, so the 60 s bound stays documentation.

## Spec Change Log

- **Review pass 1 (2026-10-18), intent_gap E4.** Counting a failed check as settled hid the case where nothing saves: health stayed green while every record failed. Before the change, the all-orgs-fail rule caught that. The owner decided health turns red. Amended the frozen stall rule and added the "Nothing saves" matrix row. Also folded in patch findings B3, B4, B5/E2, V1, V2, E3, B7/E5 and V-o1 as Code Map and Test notes. Known-bad state avoided: a green worker that records nothing. **KEEP** from pass 1. Its code is already restored in the working tree (from stash `epic-5-retro-1 pass-1`); amend it, do not start over:
  - the registry shape (`start`/`has`/`size`/`stalled`/`drain`, a monotonic injectable clock, release in `finally`)
  - `startMonitorCheck` as the shared path, and the two commands' shapes and log levels
  - `findRunnable` with the listing's `now`
  - the shutdown order: close, then await ticks, then drain, then close the app
  - the split of the old `:242-290` test into noisy-neighbour, stall and SIGTERM-timeout tests
  - the mutation check

  Only the settle rule, the tests listed above and these edits change:
  - the ARCHITECTURE 6.0.1 stall bullet, whose pass-1 text "(recorded, skipped, dropped or failed)" is now wrong
  - a new sentence at ARCHITECTURE `:832`
  - the shared due fragment in `findRunnable`, which pass 1 copied
  - removing `isLimiterClosed`'s `AggregateError` branch
- **Spec review after pass 1 (2026-10-18).** A failure that cleared when the registry emptied would have hidden fast-failing records, so the pending-failure state was added. Also added: the `overdueMs` test seam, the process-wide statement, no stall rule at shutdown, and `NotFoundException` as a skip. Registry shape after this: `start`, `has`, `size`, `stalled`, `drain`, `reset`, plus the pending-failure state.

## Review Triage Log

Review pass 1 (2026-10-18), with three reviewers: blind (B), edge-case (E) and verification-gap (V).

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| E4 | When every record fails (e.g. inserts refused), checks still "settle", so the stall rule never fires and health stays green while nothing is written. Before, `run_due_checks` rejected, the org failed, and an all-org failure rejected the pass | medium | The frozen rule then said "Every release counts as settled: recorded, skipped, dropped or failed". The old path at `worker.ts` (baseline 266-297) rejected on aggregated record failures. NFR29 and ARCHITECTURE.md:832 ("a pass that could not do its work rejects") | intent_gap (owner decided: health turns red) |
| B3 | ARCHITECTURE.md:832 says every loop, monitor checks included, follows the "could not do its work" rule, and does not mention the stall rule | low | Read at :832; 6.0.1 now adds the stall rule | patch (folded into the amendment) |
| B5/E2 | The stall test waits for the substring `monitor pass failed`, which the per-org listing-failure log also contains | low | `worker-lifecycle.integration.test.ts:301`; per-org message `monitor pass failed for organization` | patch (folded) |
| V2 | The noisy-neighbour health probe runs inside the 4 s boot grace (`worker-health.ts:91-92`), so a backlog wrongly counted as a stall would still pass | medium | One probe at `worker-lifecycle…:284`, about 1-2 s after boot | patch (folded) |
| V1 | No test starts an id while the registry is non-empty after time has passed; dropping the `pending.size === 0` guard survives every test | low | `check-registry.spec.ts:81-105` | patch (folded) |
| E3 | The re-read test's edits must all land within a 1.5 s `/hold` window | low | `due-monitors.integration.test.ts:525` | patch (folded) |
| B7/E5 | The "changed while queued" tests do not assert "no event" for a skipped monitor; the missing-monitor case omits `now` | low | `due-monitors…:495-559` assert rows and error lines only | patch (folded) |
| B4 | `findRunnable` re-types `listDue`'s due condition | low | `monitor.repository.ts` | patch (folded): one shared SQL fragment |
| V-o1 | `isLimiterClosed`'s `AggregateError` branch is unreachable | low | Its only caller sees per-monitor rejections | patch (folded): delete the branch |
| B1/E1 | One check that never settles stays registered, with health green while others settle | low | Unreachable as shown: every adapter enforces its timeout (`http-checks…:110`, `tcp-ssl-checks…:141`); the record step takes short row locks only. A per-entry age adds state | rejected |
| B2 | The backlog depth is not reported to operators | low | A new metric or log surface, outside the intent | rejected |
| B6 | Shutdown logs one `info` line per dropped check | low | Info level, at shutdown only; aggregating adds a branch | rejected |
| B8/V-o2 | `run_due_checks` has no production caller | false | The spec keeps it deliberately; the fix would edit this spec | rejected |
| B9 | The "only edits" acceptance claim misses the `afterEach` drains, the concurrency reset and the capturing logger | false | The spec's Test notes require them | rejected |
| B10 | Implementation Notes do not record verification; Code Map says `findRunnable(tx, id)` | false | Verification is recorded at step 5; the fix edits this spec | rejected |
| B3b | `epics.md:1856` (Story 5.9 AC "never overlaps itself") is stale | low | Planning artifact; it belongs to retro item 7's epics.md list | defer |

Review pass 2 (2026-10-18), with three reviewers: blind (B), edge-case (E) and verification-gap (V).

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| V1 | The tick's `checkRegistry.idle()` path, the only production path that clears a pending failure, has no test; deleting it leaves health red forever after one failed record on a monitor that stops being due | medium | `worker.ts:300`; no `runMonitorPass` test reaches `failed === 0 && due === 0` with a failure pending | patch |
| E3c | The re-read test's blocker is still `/hold?delay=1500`, against the Test note's 5 s or more | low | `due-monitors.integration.test.ts:527` | patch |
| E5c | Skipped monitors are not asserted to emit no monitor event | low | `due-monitors…:875-883` assert rows and error lines only | patch |
| E6 | The missing-monitor case does not pass `now` | low | `due-monitors…:820-844`, `queue(org.orgId)` | patch |
| E7 | `/hold?delay=600` lets the first check record before the second queue or run, so the test can fail on a slow machine | low | `due-monitors…:457`, `:777-790` | patch |
| B7 | The every-record-fails test has about 700 ms of margin: 1.5 s overdue against 800 ms sleeps plus the check, failed record and drain | low | `worker-lifecycle…:551-574` | patch |
| B2 | `finally` deletes the id even when a newer task holds it, after `reset()` | low | `check-registry.ts` `.finally(() => pending.delete(id))`; `reset()` is exported on the singleton | patch: delete only when `pending.get(id) === promise` |
| B12 | The `NotFoundException` test passes for any silent failure | low | It asserts no error lines and no rows only | patch: also assert `run_due_checks` resolves `{ checked: 0 }` |
| B4 | ARCHITECTURE's module table (`:48`) does not list `QueueDueMonitorChecksCommand` | low | Read at `:48` | patch |
| B5 | The new `deferred-work.md` entry has no `target:` | low | Entry conventions (Epic 9 retro item 8) | patch |
| B6 | AGENTS.md has no pitfall saying tests must `drain()` and `reset()` the registry | low | Only `process-check-limiter.ts` says so | defer (agent-context file) |
| B3 | A check that never settles | low | carried: pass 1 B1/E1, code unchanged | rejected |
| B4b | `run_due_checks` has no production caller | false | carried: pass 1 B8 | rejected |
| B8 | Overdue below 60 s plus recording is not enforced at boot | false | The frozen block decides "documented, not enforced" | rejected |
| B9 | The lost `lastStartedAt` assertion; a hung monitor listing untested | false | The Test notes drop that assertion on purpose; `startLoop`'s hung-pass rule is shared and covered by `worker-health.integration.test.ts:126` | rejected |
| B10 | One `info` line per dropped check at shutdown; `LimiterClosedError` marks a failure pending | low | carried: pass 1 B6; the pending flag is moot once the limiter is closed | rejected |
| B11 | A monitor disabled or archived during a run is still recorded | false | The frozen block keeps DR-4's during-run window as decided | rejected |
| B13 | "Within about 2 × overdue" leaves out tick and probe lag | low | "about" covers it; the fix is wording only | rejected |
| B14 | `start-monitor-check.ts` sits loose in `commands/` | low | Two importers; no named harm | rejected |

## Design Notes

The limiter already rotates admissions across organizations. What starved everyone was the barrier around it. Without the barrier, an organization that has not been served yet takes the next free slot ahead of one being served repeatedly. A free slot comes up roughly every timeout ÷ cap. Many organizations that each have a slow check share capacity fairly, so they get the documented bound above, not starvation by one. The registry takes over the barrier's other job, stopping a slow monitor being checked twice. The stall rule keeps NFR29 ("health says whether it is working") without counting a backlog as broken.

## Verification

**Commands:**
- `pnpm run check` -- clean, no dependency violations
- `pnpm run test`, then again with `.env` moved aside and `env -u DATABASE_URL -u BETTER_AUTH_SECRET` (never while another suite runs) -- all pass
- `docker compose up -d postgres` then `timeout 1500 pnpm run test:integration` -- all pass; rerun any failure two or three times and report it
- `pnpm run test:e2e`; `pnpm run auth:schema:check` -- pass

## Implementation Notes

- Mutation check: with the tick swapped back to `run_due_checks` (awaiting every check), the noisy-neighbour test fails with "timed out waiting for the quiet organization's result" after 10 s. Restored afterwards; with the fix it passes in about 5 s.
- Pass 2 (2026-10-18). The pass-1 code was restored from the stash and amended to the pending-failure settle rule. Also done: the `overdueMs` test seam, the shared `dueCondition` fragment, `NotFoundException` as a skip, and no stall rule once the limiter is closed. The mutation check was redone on the amended noisy-neighbour test, and it fails with the old tick.
- Review pass 2 patches were applied by the same implementer: the `idle()` path test, wider timing margins, `/hold?delay=5000`, the no-event and `{ checked: 0 }` assertions, the guarded release, and the module-table row.
- Final verification (2026-10-18, main session), all on the first run with no reruns:
  - `pnpm run check`: clean, 438 modules
  - `pnpm run test`: 262/262, and 262/262 again with `.env` moved aside
  - `pnpm run test:integration`: 643/643, with only `postgres` up
  - `pnpm run test:e2e`: 4 scenarios, 53 steps
  - `pnpm run auth:schema:check`: in sync
- Not shown live: the local database still holds 587 test organizations, each with one slow monitor. That is the documented capacity case, not one organization stalling the rest, so a live rerun would not demonstrate this fix.
