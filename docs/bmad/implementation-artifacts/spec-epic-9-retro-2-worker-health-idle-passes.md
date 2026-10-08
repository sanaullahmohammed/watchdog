---
title: 'Epic 9 retro item 2 — worker health fails when passes do no work, and shutdown always ends the pool'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: '1148d2bd8008689b6725200d184f3ac62afa9b5f'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `runWorkerPass` catches a failed tenant discovery and every organization's failure, then resolves. `startLoop` records the pass as completed, so the worker stays healthy while its database is down (retro DR-2). Separately, worker shutdown runs `await app.close(); await closeDbConnection();` unguarded, so a rejecting `app.close()` leaves the pool open and the rejection unhandled (DR-4).

**Approach:** `runWorkerPass` rejects when the pass did no work. `startLoop` already treats a rejected pass as not completed. Shutdown's closing steps move into an exported `closeWorker` that logs a failed `app.close()` and still ends the pool. ARCHITECTURE 8 states the rule first.

## Boundaries & Constraints

**Always:**
- **No work** means either tenant discovery failed, or at least one organization was visited and every one failed. A pass over zero organizations counts as completed: a fresh install has nothing due and must be healthy. So does a pass where some organizations fail and others succeed. One bad tenant must not mark the whole worker unhealthy.
- Each failure is still logged where it happens, as today. The rejection is a new `Error` whose message says why: discovery failed, or all N organizations failed. It carries no `cause`, because a nested database error escapes log redaction (DR-5).
- `closeWorker(app: Pick<FastifyInstance, 'close'>, logger)` awaits `app.close()` in a try/catch that logs, then awaits `closeDbConnection()` in a try/catch that logs. It never rejects. `shutdown` calls it after the heartbeat timer is cleared.
- Every new test drives the real `runWorkerPass` and the real `closeDbConnection`. Three of them fail without their fix: every organization failing, discovery failing, and `closeWorker`. The other two, some organizations succeeding and no organizations, pin the boundary. They fail if the rule is made too broad.
- No test runs an unscoped pass that can reach the database. The discovery test ends the pool itself, which is idempotent, and asserts that ``sql`select 1` `` rejects before it starts the loop. Running it alone or out of order therefore stays safe. Its stub app's `commandBus` is a getter that throws.
- Every loop case stops its loop and awaits `loop.inFlight` in a `finally`, so no pass is still running when the app or pool closes.

**Never:**
- No change to `startLoop`, `worker-health.ts`, `healthcheck.ts`, env settings, or Compose.
- No seam for injecting discovery. A dead pool is the real failure.
- Not starting the real worker (deferred 9.10 #11 stays open).
- Not moving test helpers to `src/shared/testing/`. That is item 4. The new cases join the existing worker-health suite, so they reuse its helpers rather than copying them.

## I/O & Edge-Case Matrix

| Scenario | Pass input | Healthcheck after the threshold |
|---|---|---|
| Every organization fails | `orgIds: ['not a valid id!']` | exit 1 |
| Some fail, some succeed | `['not a valid id!', '<well-formed, no such org>']` | exit 0 |
| No organizations | `orgIds: []` | exit 0 |
| Discovery fails | pool ended, no `orgIds` | exit 1; "tenant discovery failed" logged |
| Shutdown, `app.close()` rejects | stub app | `closeWorker` resolves, the stub's error logged, pool ended |

Row 1 is a one-organization install whose only organization fails. That counts as every organization failing.

</frozen-after-approval>

## Code Map

- `src/worker.ts`
  - :36-93 `runWorkerPass`. Discovery catch :47-52 logs and returns. Per-org catch :88 logs. `app` is used only for `app.commandBus`.
  - :101-146 `startLoop`. `health.completed` runs only after `await pass()` fulfils (:116-120). A rejection is logged at :128 as `${name} pass failed`.
  - :190-215 `shutdown`. :208-209 are the unguarded closes.
- `src/api.ts:25-33` -- the try/catch-and-log pattern for `fastify.close()`.
- `src/shared/db/postgres.ts:12-14` -- `closeDbConnection` is `sql.end({ timeout: 5 })`. After it, a query rejects.
- `src/shared/db/tenant-transaction.ts:32,44-47` -- an id outside `/^[A-Za-z0-9_-]{1,255}$/` throws `InvalidOrganizationIdError` before any SQL. A well-formed id with no organization succeeds with zero rows in both commands (`due-maintenance.integration.test.ts:318`; `recompute-service-status.event-handler.ts:90-91`).
- `src/shared/db/sql-debug.ts:9-15` -- the redact paths cover `err.*` and `error.*` but not a `cause`.
- `src/worker-health.integration.test.ts`
  - Helpers: `runHealthcheck(path, overrides)` :35, `setup(name)` :66, `quietLogger`, `sleep`, `OVERDUE_MS = 20_000`.
  - The pattern: `startLoop` at a 100 ms interval, `sleep(OVERDUE_MS + 2_200)`, then the healthcheck. The suite has `{ concurrency: true }`.
  - The file uses no database today. Each integration file runs in its own process, so ending the global pool affects only this file.
- `docs/genesis/ARCHITECTURE.md:827` -- the worker healthcheck bullet. It defines a completed pass but says nothing about a pass that did no work.
- `docs/bmad/implementation-artifacts/deferred-work.md:117-119` -- the 9.10 entry "During a database outage `runWorkerPass` logs and resolves...". This change closes it.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/ARCHITECTURE.md:827` -- add the rule: a pass whose discovery fails, or whose every organization fails, is logged and not counted. A pass over no organizations, or with some successes, counts. So a worker cut off from its database turns unhealthy once the threshold passes.
- [x] `src/worker.ts`
  - In `runWorkerPass`, the discovery catch logs and then throws. The loop counts failures, and throws when `orgIds.length > 0` and every one failed.
  - Update three comments: the `runWorkerPass` docblock (:24-35), the discovery comment (:48-50), which says a rejection goes unhandled although `startLoop` now catches it, and the `startLoop` docblock (:94-99).
  - Export `closeWorker(app, logger)` and call it from `shutdown`.
- [x] `src/worker-health.integration.test.ts`
  - Build an app once with `buildApp({ logger: false })`, as `due-maintenance.integration.test.ts:115` does.
  - Inside the concurrent describe, add three cases that run `startLoop` at a 250 ms interval with `pass: () => runWorkerPass(app, quietLogger, { orgIds })`. There is one case per matrix row: every org fails, some succeed, no organizations.
  - After that describe, add a sequential describe.
    - Its `before` closes the app. Its `after` calls `closeDbConnection()` again, so a failed `before` cannot leave the pool holding the process open.
    - First test: call `closeWorker` with a stub whose `close` rejects. Assert it resolves, that the logged object's `error` is the stub's rejection, and that ``sql`select 1` `` now rejects.
    - Second test: run `startLoop` with `pass: () => runWorkerPass(stubApp, capturingLogger)`. Assert the healthcheck exits 1, and that a captured `error` message is "tenant discovery failed; skipping this pass".
  - Add a capturing logger beside `quietLogger`: `error(_obj, msg)` pushes `msg`. That is the file's own helper, not a copy of one from another suite.
  - The new rows add one sequential wait of `OVERDUE_MS + 2_200`, about 22 s, to the file. The concurrent cases share the existing wait.
  - Update the file docblock.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- remove the entry at :117-119. Append any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when its test runs, then the outcome matches the matrix.
- Given the `runWorkerPass` or `closeWorker` change reverted, when the suite runs, then the every-org, discovery or shutdown test fails to match.
- Given the rule broadened to reject on any organization failure, or on an empty list, when the suite runs, then the some-succeed or no-organizations test fails.
- Given the due-maintenance suite, which runs passes over valid organizations, when it runs, then it still passes unchanged.

## Implementation Notes

- One deviation: the shared app needs `await app.ready()` after `buildApp`, as the worker does. Without it, no command handler is registered, and the some-succeed case sees every organization fail.
- Found while checking the diff: the two rejecting cases awaited `loop.inFlight` bare in `finally`. A pass that was in flight at `stop()` would then fail the test at random. They now use `.catch(() => undefined)`, as `shutdown` does.
- Checked by hand: undoing all three fixes at once fails exactly three cases (every org fails, `closeWorker`, discovery fails). The other ten still pass. The implementer also applied each fix's reversal and each broadening mutation in turn, and the matching case failed every time.
- Verified after the review patches: check clean; unit 135/135 with and without `.env`; integration 354/354; e2e 3/3.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Worker failures are logged under the key `error`, which pino prints as `{}`. Both new rejection messages, and every worker failure reason, are lost (blind) | medium | Reproduced: fastify's logger prints `"error":{}` for `{ error }` and the full error for `{ err }`. The rest of `src` uses `err`. | patch |
| 2 | The rejection-case exit-1 assertions accept any failure, such as a broken spawn or a config error (blind) | low | `healthcheck.ts:23-25` exits 1 on any throw. A direct one-line assertion fixes it. | patch |
| 3 | ARCHITECTURE says "one bad tenant does not mark the worker unhealthy", which is false for a one-tenant install. The rule is written for organizations only, though the bullet covers every loop (blind ×2, edge) | low | Matrix row 1 is a one-organization install. A direct rewording fixes it. | patch |
| 4 | Teardown lives only in the second describe's hooks, so filtering that describe out leaves the app and pool open and the process hangs (blind, edge) | low | `appPromise` is built at module load, and the hooks run only with their describe. | patch |
| 5 | Nothing tests that `shutdown` calls `closeWorker` (verification-gap, blind) | medium | Reverting `src/worker.ts:242` passes every test. Testing it needs the real worker started, which the spec rules out. | defer |
| 6 | `worker-health.ts:149` loses its error in the same way as #1 | low | Pre-existing, and the spec rules that file out. | defer |
| 7 | The some-succeed and no-organizations cases await `inFlight` bare, so a rejecting pass would hide the assertion output (blind, edge) | low | This is the very regression those cases guard against. Direct correction. | patch |
| 8 | "all 1 organizations failed" (blind) | low | Row 1 produces it. Direct correction. | patch |
| 9 | The 250 ms DB cases run about 175 real transactions each against the shared database (blind) | low | A 1 s interval proves the same against a 20 s threshold. Direct correction. | patch |
| 10 | `app.close()` that never settles hangs shutdown before the pool ends (edge) | low | Pre-existing await. Compose's stop timeout sends SIGKILL. A timeout race adds a branch for a case never shown. | reject |
| 11 | No summary when some organizations fail on every pass (blind) | low | By design the per-org errors are logged. A summary is a new feature. | reject |
| 12 | The api's `closeDbConnection` is unguarded in `closePromises` (blind) | medium | `src/api.ts:34`. Pre-existing. | defer |
| 13 | `closeWorker`'s pool-close catch, and its message, are untested (blind) | low | Testing it needs a seam to make `sql.end` reject. The wiring half is #5. | reject |
| 14 | The spec's Never says no change to `startLoop`, while a task edits its docblock (blind) | low | The fix edits this spec. | reject |

## Design Notes

A rejection, not a return value, is how a pass says it did no work. `startLoop`'s rule, "completed only when the promise fulfils", already encodes it. ARCHITECTURE and the 9.10 spec both describe that rule, and the `Promise<void>` type stays.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration` -- expected: all pass. Rerun a failure a few times; WSL2's clock steps back.
- `pnpm run test:e2e` -- expected: all scenarios pass.
- Revert each fix in turn, and apply each broadening mutation in turn, then run `src/worker-health.integration.test.ts` -- expected: the matching case fails.
