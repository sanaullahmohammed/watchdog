---
title: 'Story 9.10 — Worker health reports completed passes'
type: 'bugfix'
created: '2026-10-07'
status: 'done'
baseline_commit: 'd7817fa181dbe86f45ab60707557aa0e3f6f4ff8'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The worker's healthcheck passes as long as the heartbeat file is fresh, and a timer rewrites that file every 15 s whatever the passes do. A pass whose promise never settles leaves `singleFlight` gated, so every later tick is skipped and nothing is maintained, yet the worker is reported healthy (audit F-08; ARCHITECTURE section 8).

**Approach:**
- The worker keeps a small health record per loop: when the process booted, and when each loop's last pass started and last completed.
- The heartbeat timer writes that record as JSON to the heartbeat file, and the worker also writes it as each pass completes.
- The healthcheck reads the record and fails when any loop's last completion, or boot if none has completed, is older than a configured overdue threshold. It also fails when the record itself is stale, which is today's check.

## Boundaries & Constraints

**Always:**
- **The overdue threshold:** a new setting, `WORKER_PASS_OVERDUE_MS`, default `120_000` (four maintenance intervals). Boot refuses a threshold not greater than `WORKER_MAINTENANCE_INTERVAL_MS`, naming both variables.
- **Startup grace:** a loop that has not completed yet is measured from boot, so a new worker gets a grace period equal to the threshold.
- **What counts as completed:** a pass counts only when its promise fulfils. `runWorkerPass` logs per-organization failures and returns normally, so a pass with failures still counts. A pass that rejects does not.
- **Every loop:** the record is keyed by loop name, and the check covers every loop in it. Today that is `maintenance`; the monitor-check loop (section 6.0.1) registers its own when it exists.
- **The decision is a pure function** of the record, the current time and the limits, so it can be tested without a process.
- **The healthcheck's outcomes stay the same:** exit 0 when healthy, 1 otherwise. It fails closed: a missing or unparseable file, a timestamp that is not a finite date, or a record with no loops all exit 1. A `writtenAt` later than now counts as age 0, because the clock can step back.
- **The file is replaced atomically:** written to a temporary file beside it, then renamed over it, so a check never reads a half-written record.
- **A failed write never fails a pass:** it is caught and logged, as the heartbeat is today.
- **Container healthcheck targets stay as they are**: no change to `docker-compose.yml` or the Dockerfile.

**Never:**
- No database access from the healthcheck.
- No change to `runWorkerPass` or its callers in tests.

## I/O & Edge-Case Matrix

| Scenario | State | Healthcheck |
|---|---|---|
| Normal | passes completing every interval | exit 0 |
| Slow pass | one pass longer than the interval but shorter than the threshold | exit 0 |
| Stuck pass | a pass that never settles, the timer still writing | exit 1 once the threshold has passed since the last completion |
| Just started | no pass completed yet, under the threshold since boot | exit 0 |
| Never completes | no pass completed, threshold passed since boot | exit 1 |
| Timer dead | record older than `WORKER_HEARTBEAT_MAX_AGE_MS` | exit 1 |
| No or bad file | missing, not JSON, a non-date timestamp, or no loops | exit 1 |

</frozen-after-approval>

## Code Map

- `src/worker.ts`
  - :15 has `HEARTBEAT_INTERVAL_MS = 15_000`; :114-125 hold `writeHeartbeat` (writes an ISO timestamp) and its interval.
  - :131-144 hold `singleFlight(() => runWorkerPass(app, logger))`, `tick` and the maintenance interval, plus one `tick()` at startup.
  - :149-170 hold `shutdown()`, which clears both intervals.
  - Only `runWorkerPass` and `startWorker` are exported.
- `src/healthcheck.ts` -- runs at import. It compares the file's mtime with `env.worker.heartbeatMaxAgeMs` and calls `process.exit(0|1)`. Compose runs it as `node dist/healthcheck.js` (`docker-compose.yml:93-97`).
- `src/config/env.ts`
  - :33-36 hold `WORKER_HEARTBEAT_PATH` and `WORKER_HEARTBEAT_MAX_AGE_MS` (60 s); :42-47 hold `WORKER_MAINTENANCE_INTERVAL_MS` (30 s, minimum 1 s). :81-85 build the `worker` object.
  - Anything reading `@/config` needs the database settings, so the unit-tested decision must not import it.
- `src/shared/utils/single-flight.ts` -- `inFlight` stays non-null forever for a never-settling task. It is a getter, so anything wrapping it must forward it live.
- env-schema merges `.env` first and `process.env` second, so a spawned child's env overrides win (`node_modules/env-schema/index.js:98-107`). It cannot express a cross-field rule, so that check is a plain `throw` after `envSchema()` in `env.ts`. It runs for every process that imports `@/config` (the api, the seed, tests). That is harmless, because nothing sets either variable today. The Better Auth CLI loads `auth-env` only.
- This machine's clock steps back by up to 1.4 s (`deferred-work.md`, Story 9.3 entry), so the integration test leaves at least 2 s of margin on each side of every threshold.
- `src/shared/db/runtime-role.integration.test.ts:122-133` -- a worker refused at boot writes no heartbeat file. Keep that true: the record is first written after the role check.
- `src/shared/db/runtime-role.integration.test.ts:38-74` -- the spawn pattern (`process.execPath`, `--import tsx`, repo-root `cwd`, extra env) to reuse for running `src/healthcheck.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `src/worker-health.ts` (new) -- three parts:
  - The record type: `{ bootedAt, writtenAt, loops: { [name]: { lastStartedAt, lastCompletedAt } } }`, as ISO strings or null.
  - `assessWorkerHealth(record, now, { overdueMs, maxAgeMs })`: a pure function returning `{ healthy, reason }`.
  - `createWorkerHealth({ path, loops, logger })`: `started(name)`, `completed(name)` (each also writes the file), and `write()`. `write()` writes a temporary file and renames it, and catches and logs any error.
  - It does not import `@/config`.
- [x] `src/worker-health.spec.ts` -- a unit test of `assessWorkerHealth` for every matrix row, plus three more cases: the boundary at exactly the threshold (healthy), a non-date timestamp, and a `writtenAt` in the future.
- [x] `src/config/env.ts` -- add `WORKER_PASS_OVERDUE_MS` (default 120 000, minimum 1 000) as `worker.passOverdueMs`. Throw at load when it is not greater than the maintenance interval.
- [x] `src/worker.ts`
  - Extract a generic loop, `startLoop({ name, pass, intervalMs, health, logger })`. It runs one tick at once and returns `{ stop(), get inFlight() }`; the getter forwards `singleFlight`'s live value. It wraps the pass to call `started`/`completed`.
  - `startWorker` starts the `maintenance` loop with `runWorkerPass`, so a test can inject a pass.
  - The heartbeat timer stays in `startWorker`, one per process, and calls `health.write()`. A future loop adds no second writer.
  - `shutdown` calls `stop()` and awaits `inFlight`, then clears the heartbeat timer.
- [x] `src/healthcheck.ts` -- read and parse the file, then call `assessWorkerHealth` with `Date.now()` and the configured limits. Exit 0 or 1, and write the reason to stderr when unhealthy.
- [x] `src/worker-health.integration.test.ts` -- drive `startMaintenanceLoop` with injected passes, millisecond intervals and a temp file. Assert the outcome by spawning `src/healthcheck.ts` with `WORKER_HEARTBEAT_PATH`, `WORKER_PASS_OVERDUE_MS` and `WORKER_MAINTENANCE_INTERVAL_MS` set small. Cover the normal, slow-pass, stuck-pass and just-started rows (the story's four acceptance criteria).
  - Each case uses its own temp path.
  - The normal and slow cases run the healthcheck only after boot is older than the threshold, so the grace period cannot be what passes them.
  - The slow pass lasts longer than the child's interval (at least 1 000 ms), and is checked more than one interval after its completion.
  - In the stuck case, assert the file's `writtenAt` keeps advancing.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when the healthcheck runs, then it exits as the matrix says.
- Given `WORKER_PASS_OVERDUE_MS` not greater than `WORKER_MAINTENANCE_INTERVAL_MS`, when the configuration loads, then it throws naming both.

## Design Notes

- Plain Docker Compose marks an unhealthy container but does not restart it. The story's "restarted" therefore needs an orchestrator, or a later change, to act on the status. This story makes the status truthful.
- An interval minimum of 1 000 ms forces the integration test to use spawned-healthcheck limits of at least that order. Keep each case's waits within a few seconds.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass. `worker-health.spec.ts` must not load `@/config`.
- `pnpm run test:integration`, twice -- expected: all pass. Re-run a timeline-order failure; it is this machine's clock.
- `pnpm run test:e2e` -- expected: all scenarios pass.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op.

**Manual checks:**
- Start the worker against the development database. Once "Worker is ready" appears, run `node --import tsx src/healthcheck.ts`. Expected: exit 0, and the heartbeat file holds the JSON record.

## Implementation Notes

- The loop helper is `startLoop` (generic, per the revised task), not `startMaintenanceLoop`.
- Review patches applied:
  - A malformed loop entry fails closed.
  - `startLoop` refuses a loop name the record does not know, before starting any timer.
  - The env comment states the real slack: threshold minus interval.
  - The integration test uses a 20 s threshold, so a slow child start under the full suite cannot flip a case. The stuck case compares file contents, not clock values. The slow case checks while a 5 s pass is in flight.
  - Three new spawned cases: every pass rejecting, an invalid threshold, and a dead timer.
- Checked by hand: moving `completed()` into a `finally` fails the rejecting-pass test.
- Manual check, done against the development database: the worker wrote the JSON record, the healthcheck exited 0, and the worker exited 0 on SIGTERM.
- Verified: check clean; unit 123/123 with and without `.env`; integration 286/286 twice; e2e 3/3; auth schema in sync; `db:seed` a no-op.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | A non-object loop entry or one without `lastCompletedAt` falls back to boot and reads healthy (blind, edge ×2) | medium | `worker-health.ts` treats `undefined` like `null`; the spec says fail closed | patch |
| 2 | A loop name missing from the record makes `started()` throw every tick: the pass never runs, the loop is absent, the check stays healthy (gap, edge, blind) | medium | `loopFor` throws inside the gate; `assessWorkerHealth` sees only recorded loops | patch |
| 3 | The integration test's 5 s threshold, and a record that stops changing before the check, flake when a spawned child starts slowly under the full suite (edge) | medium | Story 9.9 saw a tsx child take over 8 s to start under load | patch |
| 4 | The stuck case compares wall-clock `writtenAt` 500 ms apart, which a backward step breaks (blind, edge) | low | This machine steps back up to 1.4 s | patch |
| 5 | The slow case checks after the slow pass ends, so it repeats the normal case (blind) | low | `loop.stop()` and `await inFlight` precede the check | patch |
| 6 | No test of a rejecting pass (blind, gap) | medium | No pass in any test rejects; moving `completed` into a `finally` would pass every test | patch |
| 7 | The boot refusal of threshold ≤ interval has no test (gap) | low | No test loads an invalid pair | patch |
| 8 | The healthcheck's heartbeat-age limit is never exercised through the healthcheck (gap) | low | Unit tests call `assessWorkerHealth` directly | patch |
| 9 | The env comment says a threshold ≤ interval fails a worker "between two passes"; the real slack is threshold minus interval (blind, edge) | low | Completion gap reaches interval plus pass duration | patch |
| 10 | Requiring only threshold > interval accepts values that fail any real pass; derive the default from the interval instead of throwing (blind, edge) | low | The frozen intent fixes "greater than" and a 120 000 default; nothing sets either variable today | reject |
| 11 | A worker's `startWorker` wiring is tested only by hand (gap) | medium | Spawning a real worker runs an unscoped pass, which AGENTS.md forbids; needs a seam | defer |
| 12 | During a database outage `runWorkerPass` resolves, so the worker records completions and reports healthy (edge) | low | The spec decides that a pass with logged failures counts; a restart would not cure an outage | defer |
| 13 | A future `writtenAt` is trusted without bound (blind, edge) | low | A large backward correction is rare; the record ages normally once wall time catches up | reject |
| 14 | No boot guard for `WORKER_HEARTBEAT_MAX_AGE_MS` ≤ the 15 s heartbeat (edge) | low | Pre-existing setting and behaviour | reject |
| 15 | The heartbeat is now cleared after awaiting the pass in flight, so a never-settling pass holds the process until SIGKILL (edge) | low | Deliberate in the spec: the record stays fresh while a pass drains | reject |
| 16 | `lastStartedAt` is recorded but unused; `startLoop` lives in `worker.ts`, which loads config (blind) | low | ARCHITECTURE 8 requires recording starts; the loop is tested through the integration suite | reject |
| 17 | Spec says `startMaintenanceLoop`; statuses differ; spec untracked; 9.9 closed here (blind, edge) | false | The task text names `startLoop`; step 5 sets review; the spec is withheld by design; the owner asked for 9.9's bookkeeping | reject |
