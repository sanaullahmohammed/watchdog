---
title: "Story 5.9: Run checks on the worker's own loop"
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '06349770491a9c1d24b6c41ac597872553094426'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 5.8's `RunDueMonitorChecksCommand` exists, but nothing runs it. The worker's start, health and shutdown paths are not exercised by any test.

**Approach:** Add a `monitor` loop to `startWorker`, beside the maintenance loop and built on the same `startLoop`. It runs the command for every organization at once, each tick. The process-wide limiter admits checks round-robin by organization. Add a test-only seam that starts the real worker in a child process, scoped to given organizations, so tests can drive its healthcheck and SIGTERM.

## Boundaries & Constraints

**Always:**
- The contract is story 5.8's and 5.9's acceptance criteria in epics.md. The rules are ARCHITECTURE §4 Shutdown (L155), §6.0 (the three rules, L487–492), §6.0.1 (L498–505) and §8 (L826).
- **Config.**
  - `WORKER_MONITOR_INTERVAL_MS` defaults to 10 000 and has a minimum of 1 000. It is exposed as `config.worker.monitorIntervalMs` and documented in `.env.example`.
  - The overdue cross-check moves into a pure function in `src/config/worker-intervals.ts`, which `env.ts` calls. It throws when `WORKER_PASS_OVERDUE_MS` is not greater than either interval, and the message names both variables of the pair that failed. The existing maintenance message stays word for word.
- **Monitor pass.** `runMonitorPass(app, logger, { orgIds? })` lives in `src/worker.ts`.
  - Tenant discovery has the same guard and message as `runWorkerPass`.
  - The command runs for every organization concurrently, through `Promise.allSettled`.
  - A failed organization is logged as `{ orgId, err }`.
  - When at least one organization was visited and every one failed, the pass rejects with no cause. A pass over no organizations resolves.
  - It never runs partition maintenance or reconciliation.
- **Limiter.**
  - `createLimiter`'s `run(key, task)` takes a required key, the `orgId`; the existing spec calls move to it.
  - Waiting tasks are admitted round-robin across keys, first in, first out within a key.
  - The cap still applies to the process as a whole.
- **Loop.** `MONITOR_LOOP = 'monitor'` is registered with the health record, and its loop is created by `startLoop`. Shutdown stops both loops, then awaits both in-flight passes, then clears the heartbeat, then calls `closeWorker`. It never calls `process.exit`.
- **Grace period.** `docker-compose.yml` gives `worker` a `stop_grace_period: 90s`. Without it, Docker kills the worker after 10 s, while a check may run for up to 60 s (`MONITOR_LIMITS.timeoutSeconds.max`). ARCHITECTURE §4 says the deploy must wait.
- **Seam.**
  - `startWorker(options: { orgIds?: readonly string[] } = {})` passes `orgIds` to both passes. `src/index.ts` passes nothing.
  - `src/shared/testing/worker-process.ts` exports `spawnScopedWorker`.
    - When the file runs as main, it starts the worker with the org ids from argv. It refuses an empty list (exit 1), so no test can start an unscoped worker.
    - `spawnScopedWorker` spawns `node --import tsx` on that file with the caller's env. It returns the child, its collected output and its exit.
- **Heartbeat log.** A failed heartbeat write is logged as `{ err: error }`.
- **Replicas** (owner decision, 2026-10-16). One worker process per database: the Docker Compose stack runs one, and ARCHITECTURE §6.0.1 gets a bullet saying so. Two workers would double-check due monitors, because the due query claims nothing. Claiming rows is out of scope.
- **ARCHITECTURE §4 (L155).** Its last sentence changes to say the worker's shutdown path is tested and the api's is still owed.

**Never:**
- Change 5.8's command, its due query, or 5.4–5.7 behaviour.
- Hold a transaction across a check.
- Run an unscoped pass in a test, or leave a child worker running after a test.
- Order assertions by time.

## I/O & Edge-Case Matrix

The suite is `src/worker-lifecycle.integration.test.ts`. Its setup:
- It uses its own organizations and `startTestEndpoints()`.
- `before` calls `createCheckResultPartitions()`, because a scoped worker never maintains partitions.
- In-process, it sets `config.monitor.allowedCidrs = parseAllowedCidrs('127.0.0.0/8')` before creating monitors and restores it in `after`. Both the create handler and the in-process rows check targets.
- Every target is `endpoints.origin + path`, never `createMonitor`'s default.

One shared env object goes to every child worker and every healthcheck spawn:
- `MONITOR_ALLOWED_CIDRS=127.0.0.0/8`;
- a temporary `WORKER_HEARTBEAT_PATH`;
- `WORKER_MAINTENANCE_INTERVAL_MS` and `WORKER_MONITOR_INTERVAL_MS` at 1 000;
- the row's `WORKER_PASS_OVERDUE_MS`.

The healthcheck imports `@/config`, so its env must pass the cross-check too.

Waits poll the heartbeat file or the endpoint. Never a fixed sleep, and never a comparison of timestamps against the test's clock.

| Scenario | Input / State | Expected |
|---|---|---|
| Healthy | Scoped worker; one due `http` monitor on `/ok`; overdue 20 000 | Both loops record a completion and the monitor has one result, after which the healthcheck exits 0. On SIGTERM the child exits 0 by itself |
| Overdue loop | One monitor on `/silent` with `timeoutSeconds` 15 (`intervalSeconds` 60); overdue 4 000 | Poll until the monitor loop has a `lastStartedAt` but a null `lastCompletedAt`, and maintenance's `lastCompletedAt` string has changed between two reads. Then the healthcheck exits 1 naming `loop monitor`. The output shows `monitor pass still running; skipping this tick`. SIGTERM ends the row; the child exits 0 by itself once the check times out, and the check is recorded once, as `failure`/`timeout` |
| SIGTERM in flight | Monitor on `/hold?delay=1500`; SIGTERM once `/hold` has one request in flight, with the heartbeat file read just before | The child exits 0 by itself, with no kill and within 20 s. Its output has no `closing the app failed` and no `closing the database connection failed`. The result is recorded as `success`. `/hold` saw exactly one request, and after exit the monitor loop's `lastStartedAt` string equals the one read before the signal |
| All orgs fail | `runMonitorPass` with `orgIds: [BAD_ORG_ID]`, run through `startLoop` with its own health record | Rejects with `every organization failed (1)` and logs `orgId` and `err`. The loop's `lastCompletedAt` stays null |
| Some fail | `orgIds` = [own org, `BAD_ORG_ID`] | Resolves, and the own org's due monitor is recorded |
| Discovery fails | Stub `app` whose `commandBus` getter throws, with the pool closed. This is the same stub as worker-health's discovery test at :360 | The pass rejects. `tenant discovery failed; skipping this pass` is logged and no command runs |

No monitor event has a handler yet (story 5.10 adds the first). So the drain is shown by the shutdown order: `closeWorker` → `app.close()`, which drains. No test asserts it with a handler.

Unit specs:
- `worker-intervals.spec.ts`: each pair at equal values throws naming both variables; values above both pass.
- `check-limiter.spec.ts`: at cap 1, org A queues five tasks and org B one, and B is admitted second. The cap still holds across keys.
- `worker-health.spec.ts`: a write to a path in a missing directory logs `err` carrying the error's message, never `error`.

</frozen-after-approval>

## Code Map

- `src/worker.ts` -- `runWorkerPass` (:48) is the shape to copy for discovery, failure counting and the no-cause rejection. `startLoop` (:171) is reused unchanged. `startWorker` (:218) and `shutdown` (:261) gain the second loop.
- `src/worker-health.ts:149` -- `{ error }` becomes `{ err: error }`. The file must not import `@/config`.
- `src/config/env.ts:45-79,115-120` -- the interval vars and the inline cross-check, which moves out. `src/config/check-results-env.ts` (+ its spec) is the pattern: a pure file that a unit spec loads without `.env`.
- `src/modules/monitoring/checks/check-limiter.ts` (+ spec), `process-check-limiter.ts`, and `run-due-monitor-checks.handler.ts:39` -- the only `checkLimiter.run` caller, which gains the `orgId` key.
- `src/worker-health.integration.test.ts` -- `runHealthcheck` (:54, passes only the overdue threshold and the maintenance interval), `quietLogger`/`capturingLogger`, `BAD_ORG_ID` and the discovery test (:360) to mirror.
  - Add `WORKER_MONITOR_INTERVAL_MS` = `CHILD_INTERVAL_MS` to `runHealthcheck`'s env. Its `OVERDUE_MS` of 20 000 passes today, but the default 10 000 must not decide the result.
  - The test "refuses a loop that is not registered" uses the name `monitor` with its own `loops: ['maintenance']`. Rename that name to `rollup`.
- `docker-compose.yml` `worker` (:78) -- add `stop_grace_period`.
- `src/shared/db/runtime-role.integration.test.ts:~40-70` -- the spawn idiom (`process.execPath, ['--import','tsx', …]`, cwd `REPO_ROOT`, 60 s SIGKILL guard).
- `src/shared/testing/test-endpoints.ts` (`/ok`, `/silent`, `/hold`, `peakInFlight`), `fixtures.ts` (`createMonitor`, `setMonitorCheckState`, `createCheckResultPartitions`), and `tenant.ts`.
- `.dependency-cruiser.js` -- `no-orphans` warns on an unimported file, so the test must import `worker-process.ts`. Load `@/worker` there through a dynamic import inside the main branch, so that importing the helper does not load config. The project is CommonJS, so main means `require.main === module`.
- `docs/genesis/ARCHITECTURE.md` -- add the single-worker bullet after :505, and amend the last sentence of :155.
- `.env.example` -- it has no `WORKER_*` entries. Add only `WORKER_MONITOR_INTERVAL_MS`, commented with its default, beside `MONITOR_CHECK_CONCURRENCY`.
- **Review loop 1 amendments.** Each of these elaborates a rule above; none relaxes one.
  - **Shutdown drops queued checks** (ARCHITECTURE §4, "stop taking new work").
    - `check-limiter.ts` gains `close()` and an exported `LimiterClosedError`.
    - After `close()`, every waiting `run` rejects with that error without starting its task, and so does every later `run`. Tasks already running finish.
    - `shutdown` calls `checkLimiter.close()` (from `process-check-limiter.ts`; `src/worker.ts` is a composition root) right after stopping both loops and before awaiting the passes. Checks that never started stay due for the next worker.
    - `run-due-monitor-checks.handler.ts` is not touched beyond the key. In `runMonitorPass`, an organization whose rejection is a `LimiterClosedError`, or an `AggregateError` made only of them, is logged at `info` as `checks not started; worker is shutting down`, not as a failure.
  - **Scoping proof.**
    - In the Healthy row, a second organization with a due `/ok` monitor is left out of the child's argv. It is checked by the parent's own `results` helper.
    - After both loops complete, the test waits for the monitor loop's `lastCompletedAt` string to change once more. It then asserts that organization has no results.
  - **Handler key proof.** A case in `due-monitors.integration.test.ts`:
    - `checkConcurrency` 1; org A has three `/hold?delay=300&m=aN` monitors and org B one `/hold?delay=300&m=b1`.
    - Both commands run under `Promise.all`.
    - `endpoints.requests` shows B's request second. That is arrival order, not a clock.
  - **Overdue row without the race.**
    - Wait for the monitor loop to start and for maintenance's `lastCompletedAt` to change between two reads.
    - Then rerun the healthcheck, through the polling helper, until it exits 1 naming `loop monitor`, bounded at 10 s.
    - After that, assert that the monitor loop's `lastCompletedAt` is still null, which proves the failure came while the check hung.
    - Do not count six completions.
  - **Shutdown with a queue.** A child with `MONITOR_CHECK_CONCURRENCY=1` has two due `/hold?delay=1500` monitors. It gets SIGTERM once `/hold` has one request in flight. It exits 0 by itself. `/hold` saw exactly one request; one monitor has a `success` result and the other has none.
  - **Test helpers** (constraint 9). `runHealthcheck(env)` moves into `src/shared/testing/worker-process.ts`, and both suites use it. `worker-health.integration.test.ts` keeps its overrides by building the env itself.
  - **`spawnScopedWorker`.** It resolves `exit` on `'close'`, so the output is complete. A `'error'` listener appends the error to the output and resolves `null`. `fail()` writes `error.stack` when there is one.
  - **Config text.**
    - `WORKER_MONITOR_INTERVAL_MS` gets `maximum: 2_147_483_647`, because a larger value makes Node's `setInterval` fire every 1 ms. It also gets a comment.
    - The `WORKER_PASS_OVERDUE_MS` comment in `env.ts`, and a new commented entry for it in `.env.example`, say it must cover the longest expected pass: for the monitor loop, the interval plus about ceil(due checks ÷ `MONITOR_CHECK_CONCURRENCY`) × the slowest `timeoutSeconds`.
    - The stale header comment above `runWorkerPass` in `src/worker.ts` ("ROADMAP phase 5 fills this in…") is brought up to date.
  - `worker-health.spec.ts` writes under a missing subdirectory of an `mkdtempSync` directory, not at the filesystem root.
- **KEEP.** The iteration-1 implementation passed every check and is right except where the amendments above say otherwise. It is at `/tmp/claude-1000/-home-sleipnir-projects-watchdog/d87f5063-3094-4e83-9bfc-f55727285f21/scratchpad/keep-iteration-1.patch`; apply it with `git apply` as the starting point, then make the amendments. Keep these:
  - the round-robin limiter, ordered by `lastServed` (the subagent's first "next key that is not the last" version starved a third key);
  - the three-key limiter spec;
  - `deleteOrgs()` running before the discovery test closes the pool;
  - `require('@/worker')` inside the main branch;
  - the closed deferred entries.
- `deferred-work.md` -- delete these whole entries, by entry rather than by line:
  - 9.10, `startWorker` health wiring: the whole section, :103-109.
  - Retro item 2, shutdown: :168-171.
  - Retro item 2, heartbeat `{ error }`: :176-179.
  - Both 5.8 entries, with their section header: :224 to the end.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/worker-intervals.ts` (+ `.spec.ts`), `src/config/env.ts`, `.env.example` -- the variable and the cross-check
- [x] `src/modules/monitoring/checks/check-limiter.ts` (+ spec), `run-due-monitor-checks.handler.ts` -- the keyed round-robin limiter
- [x] `src/worker-health.ts` (+ spec) -- log the failed write under `err`
- [x] `src/worker.ts` -- `runMonitorPass`, the monitor loop, the `orgIds` option and shutdown of both loops
- [x] `src/shared/testing/worker-process.ts` -- the scoped child entry and `spawnScopedWorker`
- [x] `src/worker-lifecycle.integration.test.ts` -- every matrix row; kill any child left running in `after`
- [x] `src/worker-health.integration.test.ts` -- the monitor interval in `runHealthcheck`; rename the unregistered loop name
- [x] `docker-compose.yml` -- `stop_grace_period: 90s` on `worker`
- [x] `docs/genesis/ARCHITECTURE.md`, `deferred-work.md` -- the single-worker bullet and the §4 sentence; remove the closed entries

- [x] `src/modules/monitoring/checks/check-limiter.ts` (+ spec), `src/worker.ts` -- `close()`, `LimiterClosedError`, shutdown calls it, `runMonitorPass` logs it at info
- [x] `src/modules/monitoring/due-monitors.integration.test.ts` -- the handler key case
- [x] `src/worker-lifecycle.integration.test.ts`, `src/shared/testing/worker-process.ts` -- the scoping proof, the race-free overdue row, the queued-shutdown case, `runHealthcheck` moved, `'close'`/`'error'`, the stack
- [x] `src/config/env.ts`, `.env.example`, `src/worker.ts`, `src/worker-health.spec.ts` -- the config text, the header comment and the spec's temporary path
- [x] `deferred-work.md` -- one new entry under "From Story 5.9": the monitor loop gates a whole pass, so one organization's slow check delays every organization's next pass by up to its timeout. Lifting that means relaxing "never overlaps itself" per organization, which is the owner's call

**Acceptance Criteria:**
- Given story 5.9's criteria, when the unit and integration suites run, then each criterion is proven, and the api's shutdown entry (Story 9.9, Epic 8) is still open.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row.
- **Limiter fix.** The subagent's limiter picked "the first key that is not the last one served", which alternates between two keys and starves a third. The main session rewrote it: the waiting key served longest ago goes next, and a key's state lasts while it has a task waiting or running. The new spec case with three organizations fails on the subagent's version and passes on this one.
- **Cleanup order.** The discovery test closes the shared pool, after which `after()` could not delete the file's organizations and swallowed the error. It now runs last and deletes them before closing.
- **Seam.** `worker-process.ts` loads `@/worker` with `require` inside the main branch. A dynamic `import()` fails `tsc` under this tsconfig.
- **Overdue row.** It waits for six distinct maintenance completions, so the boot is older than the 4 s threshold without reading the test's clock. The row takes about 19 s, because the check runs to its 15 s timeout.
- **Verification.** Run by the main session on 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 245 of 245, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 549 of 549 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.

- Review loop 1 found a bad_spec entry (queued checks start after SIGTERM). The code was reverted to the baseline and the spec amended (see the Spec Change Log). The iteration-1 code is saved as the KEEP patch the Code Map names.
- Loop 1 re-derivation: a fresh Sonnet subagent applied the KEEP patch, then made the amendments. The main session read the delta against baseline plus the KEEP patch. Verification by the main session, 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 246 of 246, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 551 of 551 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.
  - No child worker was left running.
- Review pass 2: 13 patch findings went back to the same implementation subagent, and the main session read the new rows and the JSDoc fix. Final verification by the main session, 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 246 of 246, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 554 of 554 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.
  - No child worker was left running.

## Spec Change Log

- **Loop 1**, 2026-10-16.
  - **Trigger:** review B3/E2/E10. On SIGTERM the process-wide limiter keeps admitting checks that were still waiting for a slot. A backlog can then outlast `stop_grace_period`, and Docker's SIGKILL loses results, against ARCHITECTURE §4's "stop taking new work".
  - **Amended:** the Code Map ("Review loop 1 amendments", which also carries the patch-grade findings so the re-derivation includes them), the Tasks and the Design Notes.
  - **Known-bad state avoided:** shutdown that drains a limiter queue it should drop.
  - **KEEP:** see the Code Map's KEEP bullet.

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| B3/E2/E10 | Queued checks keep starting after SIGTERM, so shutdown can exceed the 90 s grace | medium | `shutdown` clears only the loop timers, and the limiter's `admit()` keeps resolving waiting tasks. bad_spec: loop 1, limiter `close()` |
| B1/V-o1 | One slow check holds every organization's next pass; the comment and Design Notes claim otherwise | medium | `startLoop` single-flights the whole `runMonitorPass`, which awaits every org. The fix needs per-org overlap, which the frozen "never overlaps itself" excludes. defer (new entry); comment corrected in loop 1 |
| B2/V-o2/E3 | The overdue threshold does not cover a long monitor pass | low | At the default 10 s timeout, 120 s takes over 100 hung checks at cap 10; it rises with 60 s timeouts. patch (documented in env.ts and `.env.example`), via loop 1 |
| V1 | Nothing proves the handler keys the limiter by `orgId` | medium | Pre-verified. patch (handler key case), via loop 1 |
| V2/B5 | Nothing proves the child worker stays scoped | medium | Pre-verified. patch (scoping proof in the Healthy row), via loop 1 |
| B4/E8 | `exit` resolves on `'exit'` before the output drains; no `'error'` listener | low | Node emits `'close'` after the stdio streams end; negative output assertions could miss late lines. patch, via loop 1 |
| B6/E7 | The overdue row races the 15 s check timeout | medium | Boot, six 1 s completions and a tsx healthcheck spawn must all fit under 15 s. patch (poll the healthcheck, then assert `lastCompletedAt` is still null; the frozen 15 s stays), via loop 1 |
| B14 | `runHealthcheck` is copied into a second suite | low | Constraint 9 puts shared helpers in `src/shared/testing/`. patch, via loop 1 |
| B9 | Stale comments and docs: the `worker.ts` header, the overdue comment, no comment on the new var, `.env.example` | low | Direct corrections. patch, via loop 1. ARCHITECTURE §6.0's "the pass in flight" stays true per loop, so it is unchanged |
| E4 | An interval above 2^31−1 makes `setInterval` fire every 1 ms | low | Node clamps oversized delays to 1. patch (`maximum`), via loop 1 |
| B13 | `fail()` drops the stack | low | Direct correction. patch, via loop 1 |
| B15 | The heartbeat spec writes at the filesystem root | low | Direct correction. patch, via loop 1 |
| B7 | The single-worker rule is not enforced and no longer tracked | low | Owner decision 2026-10-16, recorded in ARCHITECTURE §6.0.1. Compose recreates a service by stopping the old container first. rejected |
| B8 | sprint-status says in-progress while the spec says in-review | false | Step 5 sets `review` when presenting |
| B10 | Skipped-tick warnings become routine for the monitor loop | low | The frozen Overdue row requires the skip message in the child's output at the configured level. rejected (conflicts with the frozen row) |
| B11 | Limiter key cleanup is untested; a returning key gets `lastServed` 0 | low | A returning key has not been served recently, so going first is fair. A cleanup test needs a new public size accessor. rejected (unlikely) |
| B12 | `listDue` transactions are not capped; one per org per tick | low | postgres.js queues them on its pool; each is one short read. rejected (unlikely at self-hosted scale) |
| E1 | A synchronous `commandBus.execute` throw escapes `allSettled` | false | `command-bus.ts:36-46` throws synchronously only for a malformed or unregistered command. The command is registered at boot, and any test would fail loudly |
| E5 | An existing `.env` with overdue between the maintenance interval and 10 000 now fails boot | false | The intended rule: the story's criterion says boot fails naming both |
| E6 | `docker compose up -d` starts a compose worker that interferes with the suites | low | Already tracked: the deferred entry "From Story 5.3". rejected (duplicate) |
| E9 | A crashed test runner orphans the child worker | low | Needs a stdin-close watchdog in the child; `after` kills children in normal runs. rejected (unlikely) |

Review pass 2, after loop 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| E8 | `runMonitorPass`'s JSDoc still says no organization waits behind another's slowest timeout | medium | `src/worker.ts:152-153` was not corrected in loop 1; the pass-1 B1 row said it would be. patch |
| V1/B3 | Nothing proves the child's maintenance loop is scoped | medium | Pre-verified. Dropping `orgIds` from `runWorkerPass` would run unscoped reconciliation and partition drops, and every test passes. patch (outsider's drifted status survives) |
| V2/B4/B5 | The `LimiterClosedError` classification and the `AggregateError` branch are never asserted | medium | Pre-verified. The queued row has one dropped check and never reads the output. patch (three monitors, output assertions) |
| V3 | The monitor loop's interval is indistinguishable from maintenance's in every test | medium | Pre-verified. Both suites use 1 000 for both. patch (row with distinct intervals) |
| B1 | The 15 s heartbeat timer is untested, though the 9.10 entry it closes names it | medium | Every child row rewrites the record each second through the loops. patch (row with both loops idle) |
| V4 | The seam's refusal of an empty org list is untested | low | Pre-verified. patch |
| B2/E7 | The retro item 2 entry is closed, but shutdown's use of `closeWorker` is still unproven | medium | A direct `app.close()` + `closeDbConnection()` shutdown passes every SIGTERM row. Proving it needs a fault-injection option on `startWorker`. patch: a narrowed deferred entry restores the open half |
| B7/E6 | The due-monitors key case waits without a deadline | low | `for (;;)` with no bound; a rejection of `first` hangs it. patch |
| B8/E2 | `WORKER_MAINTENANCE_INTERVAL_MS` has no maximum | low | Pre-existing; a direct correction matching E4. patch |
| E4 | `runHealthcheck` has no `'error'` listener | low | A failed spawn emits an unhandled `'error'`. patch |
| E5 | `childEnv` inherits `LOG_LEVEL` | low | With `.env` `LOG_LEVEL=error`, the skip warning never prints. patch |
| B9/B10 | ARCHITECTURE §6.0.1 does not state round-robin admission, dropped queued checks or the grace-period requirement | low | It is the document of record (AGENTS.md). patch |
| B12 | `.env.example` lines inconsistent; the maximum is not mentioned | low | The Code Map asked for "commented with its default". patch |
| B13 | The single-worker rule is not enforced | low | carried: pass 1 B7, rejected (owner decision) |
| E1 | A long first pass after restart can pass the overdue threshold | low | carried: pass 1 B2/V-o2/E3, documented |
| B6 | A mixed shutdown failure is logged as a failure; an all-dropped pass counts as completed | low | The organization did have a real failure, so error-level is accurate. A completion at shutdown is never read, because the process is exiting. rejected |
| B11 | Implementation Notes keep the iteration-1 overdue description | low | The fix edits this build's spec; the loop-1 note already records the re-derivation. rejected |
| E3 | Deleting a monitor mid-check makes the org count as failed | false | v1 has no monitor delete (epic-5-context); an org delete is the separate 5.6 deadlock entry |

## Design Notes

Organizations run concurrently, and the limiter is round-robin.
- Running them in turn would avoid the 5.8 fairness entry, but every later organization would wait for an earlier one's slowest timeout, up to 60 s each, on every tick.
- Running them concurrently with a FIFO limiter would let one large organization hold the queue.

Concurrency does not remove the delay entirely. The loop never overlaps itself, so the next pass for every organization still waits for this pass's slowest check. A 30-second monitor can therefore be checked only every ~60 s while another organization's target hangs. That bound is one timeout, not the sum of timeouts, and it is recorded in deferred work.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass, with only postgres and mailpit up. Rerun any failure 2–3 times and report all of them.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- pass
