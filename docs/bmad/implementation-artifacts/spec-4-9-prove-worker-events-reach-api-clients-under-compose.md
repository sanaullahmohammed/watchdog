---
title: 'Story 4.9 — Prove worker events reach api clients under Compose'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '8c484dbadfde379c771f989c96af585f4e87ab53'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The LISTEN/NOTIFY backplane is proven only inside one process. Nothing shows that a change the worker makes reaches a client of the separate `api` process, which is the case the backplane exists for (FR16, ARCHITECTURE section 9, decided 2026-10-18).

**Approach:**
- A `test:compose` suite runs against the real stack: the built image's `api` and `worker`, started by `docker compose --profile app up --wait` in a Compose project of its own.
- A controlled target, provided only to this stack, answers 503. A monitor on it breaches its threshold.
- The test watches both channels:
  - the public stream receives the page where the service moved to `major_outage`;
  - the admin subscription receives `monitor.threshold_breached` and `incident.draft_created`.
- It first shows that nothing happens while the worker is stopped.
- A new CI `compose` job runs it on every pull request.

**Decisions (owner, 2026-10-21):**
- `AGENTS.md` gets one "Running and verifying" bullet: how to run `test:compose` locally, and that its stack uses its own project and database, so the integration rule's `app`-profile warning does not apply to it. No other `AGENTS.md` edit.
- ARCHITECTURE section 9 gets the `compose` job row in its table, and line 866 is reworded so it no longer calls the booted-container check only planned. No other `docs/genesis` edit.
- The local stack may be built and run during this build. It is torn down afterwards.

## Boundaries & Constraints

**Always:**
- The stack is the base `docker-compose.yml` plus an override, `docker-compose.backplane.yml`, under the project name `watchdog-backplane`. The override:
  - adds a `backplane-target` service under its own profile, `backplane`. It is a pinned `nginx` alpine image whose config answers 503 to every path, at the fixed address `10.213.7.10`, on the `backplane` network only;
  - adds the `backplane` network, subnet `10.213.7.0/24`. `api` and `worker` join it with `networks: [default, backplane]`. Naming only `backplane` drops `default`, which was checked with `docker compose config`;
  - sets `MONITOR_ALLOWED_CIDRS=10.213.7.10/32` on `api` (creation-time check) and `worker` (connect-time check). Only the target is allowed: no gateway and no other container;
  - sets `WORKER_MONITOR_INTERVAL_MS=1000` and `WORKER_PASS_OVERDUE_MS=10000` on `worker`;
  - publishes only the `api`, as `ports: !override ['127.0.0.1:3100:3000']`. `postgres` and `mailpit` get `ports: !reset []`, so the stack never collides with the dev stack or its database.
- Every command for this stack runs with `COMPOSE_PROJECT_NAME=watchdog-backplane`, `COMPOSE_FILE=docker-compose.yml:docker-compose.backplane.yml` and `COMPOSE_PROFILES=app,backplane` set. Without the profiles, `down`, `stop`, `start` and `logs` skip the profile-gated services.
- The test is black-box over HTTP and WebSocket at `COMPOSE_API_URL` (default `http://127.0.0.1:3100`).
  - It sends `Origin: http://localhost:3000`, the stack's `BETTER_AUTH_URL`.
  - It imports only `src/shared/testing/graphql.ts`, never `tenant.ts` or anything that loads `src/config` or a pool. It has its own origin constant and cookie builder (`headers.getSetCookie()`).
  - It drives the worker only through `docker compose stop worker` and `start worker`, each bounded at 30 s with a named failure.
  - Before the sequence, it reads `docker compose config --format json` and asserts:
    - `MONITOR_ALLOWED_CIDRS` on `api` and `worker` is exactly the target's address as a `/32`;
    - `api` is the only service with a host port, bound to `127.0.0.1`;
    - `api` and `worker` are on both `default` and `backplane`.
- Its sequence:
  1. Sign up and create an organization over `fetch`.
  2. Create a public service.
  3. Open the public stream (`GET /status/:slug/events`) and the admin subscription.
  4. Stop the worker.
  5. Create an `http` monitor on `http://backplane-target/` with `failureThreshold: 1` and `intervalSeconds: 30`.
  6. For three worker intervals, assert that the monitor's `lastCheckedAt` stays null and that no monitor or incident event arrives. The api runs no checks.
  7. Start the worker.
  8. Expect the first pushed frame whose service is `major_outage`, not the opening frame, and the two events naming that monitor and its draft.
- The failure threshold comes from `COMPOSE_TEST_FAILURE_THRESHOLD` (default 1). The wait bound is computed in code: 15 s for worker startup, plus `(threshold - 1) × intervalSeconds`, plus one worker interval, plus 15 s slack, unless `COMPOSE_TEST_WAIT_MS` overrides it. A miss fails within the bound, with a message naming what did not arrive.
- `test:compose` is `node --import tsx --test 'tests/compose/**/*.compose.test.ts'`, with the glob quoted. `cucumber.mjs` must no longer load `tests/compose/`, and e2e still runs every scenario.
- CI `compose` job, separate from `database`, on every pull request:
  1. Build the image.
  2. `up --build --wait --wait-timeout 180`, with the three `COMPOSE_*` variables set at job level.
  3. Install and run `test:compose`.
  4. On failure, print `docker compose logs --no-color`.
  5. Always `down -v`.
- Integration suites keep running with only postgres, mailpit and migrate. This stack uses its own project and volume.

**Never:**
- No `setNotFoundHandler`, no migration, and no application code change. No edits to `AGENTS.md` or `docs/genesis` beyond the Decisions.
- The target guard is not loosened in the base compose file or the app's defaults.
- No marker or process identifier in the NOTIFY payload.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Worker stopped | Monitor created, worker stopped for 3 worker intervals | `lastCheckedAt` null (`GET /api/v1/services/:id/monitors`). No `monitor.*` or `incident.*` signal. No frame after the opening one |
| Worker breach | Worker started | The page pushes with the service `major_outage`. The subscription gets `monitor.threshold_breached` (aggregateId = monitor id) and `incident.draft_created` |
| Guard scope | `docker compose config` of the stack | `MONITOR_ALLOWED_CIDRS` on `api` and `worker` is exactly `10.213.7.10/32`. Only `api` publishes a port, on `127.0.0.1` |
| Missed delivery (Constraint 11) | `COMPOSE_TEST_FAILURE_THRESHOLD=20`, with `COMPOSE_TEST_WAIT_MS` set to the bound computed for a threshold of 1 | The test fails within that bound, naming the missing signal. Recorded |
| CI | Pull request | The `compose` job runs and fails the build on failure |

</frozen-after-approval>

## Code Map

- `docker-compose.yml` -- the `x-watchdog-image` anchor (`watchdog:dev`, build `.`). `api` (`:56-81`, publishes `3000:3000`, `BETTER_AUTH_URL=http://localhost:3000`) and `worker` (`:83-106`) are under `profiles: ['app']`. postgres publishes 5432, and nothing declares networks. Leave the base file unchanged unless the override cannot express something.
- `Dockerfile` -- the runtime is `node dist/index.js`, and `tests/` is not in the image.
- `.github/workflows/ci.yml` -- the `check` job's setup block (`:18-27`) to copy. The `docker` job (`:127-144`) builds with buildx. The new job may build through `docker compose build` instead.
- `src/config/env.ts:67-94`, `src/config/worker-intervals.ts` -- worker intervals (minimum 1000). Overdue must exceed both intervals. `MONITOR_ALLOWED_CIDRS` takes strict CIDRs.
- Monitor flow, all in the worker:
  - `runMonitorPass` (`src/worker.ts`) checks a new monitor on its next tick.
  - `record-check-result` emits `monitor.threshold_breached` at threshold.
  - `create-draft-from-monitor.event-handler.ts` emits `incident.draft_created`.
  - Recompute maps failing to `major_outage` and emits `service.status_changed`.
  - `src/api.ts` builds with `{ listen: true }` and has no check loop.
- REST, served at `/api/v1/...` (prefix `/api` plus the routes' `/v1`):
  - `POST /api/v1/services` takes `{ name, slug, isPublic }`.
  - `POST /api/v1/monitors` takes `{ serviceId, type, name, target, intervalSeconds, failureThreshold }`. Its limits are in `monitor-limits.ts:9-16`: interval of at least 30, threshold of at least 1.
  - The monitor's `lastCheckedAt` is read through the existing monitor list query (`list-monitors`).
- Auth over `fetch`:
  - `POST /api/auth/sign-up/email`, then `POST /api/auth/organization/create`, with `origin`.
  - Build the cookie from `headers.getSetCookie()`, as `captureCookie` does (`src/shared/testing/tenant.ts:21-24`). `signUpWithOrg` itself uses `app.inject` and SQL, so it is unusable here.
- Clients:
  - `openSubscription(baseUrl, { cookie, origin })` in `src/shared/testing/graphql.ts` works against a real URL.
  - The SSE reader pattern is `hold()` in `tests/status-page/public-status-stream.steps.ts:24-60`. Copy it, or move it to `src/shared/testing/` and reuse it.
- `cucumber.mjs` `require: ['cucumber.setup.js', 'tests/**/*.ts']` would load the compose test. Narrow it to the support files and `*.steps.ts` files that exist today (`tests/support/*.ts`, `tests/*/*.steps.ts`). Check that e2e still reports 10 scenarios.
- `src/shared/testing/test-globs.spec.ts` checks every `--test` script's globs are quoted.

## Tasks & Acceptance

**Execution:**
- [x] `docker-compose.backplane.yml` -- the override, per Boundaries.
- [x] `tests/compose/backplane.compose.test.ts` -- the sequence and bounds per Boundaries.
- [x] `package.json` -- `test:compose`.
- [x] `cucumber.mjs` -- narrow the `require` globs.
- [x] `.github/workflows/ci.yml` -- the `compose` job.
- [x] `AGENTS.md` -- the one bullet from the Decisions.
- [x] `docs/genesis/ARCHITECTURE.md` section 9 -- the `compose` row, and line 866 reworded.

**Acceptance Criteria:**
- Given `pnpm run check`, unit (with and without `.env`), integration and e2e, when run, then all pass.
- Given the local stack, when `pnpm run test:compose` runs, then it passes. Run as the Missed delivery row describes, it fails, naming the missing signal. Record both runs, and confirm `up --wait` returns 0 with `migrate` exited 0.

## Implementation Notes

- `WORKER_MAINTENANCE_INTERVAL_MS=5000` is also set on `worker`. `assertWorkerIntervals` refuses to boot unless `WORKER_PASS_OVERDUE_MS` exceeds both loop intervals, and the maintenance default (30000) exceeds the 10000 the spec sets.
- The test fixes the three `COMPOSE_*` variables for its own `docker compose` calls, so it cannot stop the dev stack's worker even if the caller's shell lacks them. It reads the worker interval from `docker compose config` rather than repeating it.
- The draft is tied to the monitor by reading `GET /api/v1/incidents/:id` for the `incident.draft_created` aggregate: `draft`, source `monitoring`, affecting only the test's service.
- Both channels are proven live before the worker stops: they open before the service exists, and the service's creation must arrive as `service.created` on the subscription and as a pushed page listing it. A stream end or a socket close is reported as itself, not as silence.
- The worker-stopped window is 11 s (the application's default 10 s monitor interval plus 1 s), not 3 s, so a check loop wrongly running in the api at its default interval would be seen.
- Recorded runs (2026-10-21, local WSL2):
  - `up --build --wait --wait-timeout 180` returned 0; `migrate` Exited (0).
  - `pnpm run test:compose`: 2 pass, 0 fail (breach test about 17 s with the 11 s window). Passed again after `down -v` and a fresh `up`.
  - Missed delivery, `COMPOSE_TEST_FAILURE_THRESHOLD=20 COMPOSE_TEST_WAIT_MS=31000`: failed within the 31 s bound after the worker start (45 s overall with the 11 s window), with `no public page with Backplane API as major_outage; no monitor.threshold_breached for monitor <id>; no incident.draft_created`. Frames were `["operational","degraded"]`; signals `service.status_changed`, `uptime.rollup_refreshed`.
  - Integration (730 pass) ran with the backplane stack up beside the dev postgres and mailpit.

- Orchestrator, after the review patches (2026-10-21):
  - Triage #22 was applied directly: the liveness step re-touches the service each `LIVENESS_POKE_MS` until it hears `service.created` or `service.updated`.
  - Verification:
    - `pnpm run check` is clean (11 pre-existing warnings).
    - Unit: 346 of 346, with and without `.env`.
    - Integration: 730 of 730.
    - e2e: 10 of 10.
    - Auth schema: in sync.
    - On the backplane stack (`up --build --wait` returned 0), `test:compose` passed 2 of 2, twice.
    - The missed-delivery run (`COMPOSE_TEST_FAILURE_THRESHOLD=20`, `COMPOSE_TEST_WAIT_MS=31000`) failed within its bound, after 46 s in all, naming all three missing signals.
    - `down -v` left nothing behind.
  - Deferral #11 was appended to `deferred-work.md`.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-21). Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `test:compose` exits 0 when its glob matches no file, so the CI job could pass with no assertion (V) | medium | Pre-verified: `node --test 'nonexist/**/*.compose.test.ts'` exits 0, and `test-globs.spec.ts` checks quoting only | patch |
| 2 | `workerStopped` is set only after `stop worker` returns. If the 30 s bound fires, the daemon still stops it, and `after` never restarts it (B, E) | low | The flag is set after the await. A direct reorder | patch |
| 3 | The worker-stopped window is 3 s, the worker's override interval. A check loop in the api, at the default 10 s, could fire after it (B) | medium | The api has no override, and the window is `3 × WORKER_MONITOR_INTERVAL_MS` of the worker | patch |
| 4 | A closed subscription or an ended stream reads as "no signal", and the quiet check passes on a channel that never went live (B, E) | medium | `next()` rejections become `undefined`. `hold()`'s `done` branch records nothing. Nothing proves either channel live before the quiet window | patch |
| 5 | `ORIGIN` and `API_URL` repeat values the test already reads from `docker compose config` (B) | low | A drift gives an auth or connect error instead of a named mismatch. A direct change | patch |
| 6 | No overall time limit: the CI job has no `timeout-minutes`, and `fetch` calls have no abort timeout (B) | low | A hung api would hold the job for GitHub's 6 h default | patch |
| 7 | The CI job builds the image twice (`build`, then `up --build`) (B) | low | A direct deletion. Caching is speed only | patch (drop the extra step) |
| 8 | No minimum Compose version is stated for `!reset`, `!override` and inline `configs` (B) | low | An older Compose fails to parse the override. One clause in the AGENTS bullet | patch |
| 9 | If the breach test runs alone, `workerIntervalMs` is unset, and the quiet window is `setTimeout(NaN)`, so it passes vacuously (E) | low | It is read in the first test. A direct guard in `before` | patch |
| 10 | The config assertion does not check that the target is on the `backplane` network only (E) | low | A direct assertion | patch |
| 11 | ARCHITECTURE still says the job runs `--profile app up`, section 8 says the `app` profile stays down for the integration suites, and the reworded sentence keeps its "Planned checks" lead-in (B, E) | low | `ARCHITECTURE.md:866-868`, section 8. The owner allowed only the row and line 866 | defer |
| 12 | Two local runs at once share one project, and the fixed subnet can clash with a host network (B, E) | low | Either fails loudly ("Pool overlaps"), or is a rare double run on one machine | reject |
| 13 | The narrowed Cucumber globs have no guard (B) | low | A step file the globs miss leaves undefined steps, which cucumber's strict default fails | reject |
| 14 | The SSE reader is a copy of `hold()` (B) | low | Drift only, with no runtime harm | reject |
| 15 | Reruns on a stack still up leave failing monitors behind (B) | low | Each run uses a new organization. The extra monitors do not affect a later run's assertions | reject |
| 16 | `COMPOSE_TEST_WAIT_MS` above the timer cap fires at once (E) | low | An operator's own misconfiguration of a test knob | reject |
| 17 | A rejected `Promise.all` branch leaves its sibling's timer running until the deadline (E) | low | Only on an already failing run, and bounded | reject |
| 18 | The stack's build retags the shared `watchdog:dev` image (E) | low | Same source tree, and the dev stack rebuilds on `--build` | reject |
| 19 | The spec's Intent names `--profile app up` (E) | low | The fix is an edit to this build's spec. Boundaries name the real command | reject |
| 20 | The spec and sprint statuses disagree, and 4.8's done is bundled (B) | false | Step 3 sets `in-progress`, and 4.8 → done was the owner's instruction for this branch | reject |
| 21 | The required checks have no recorded results (B) | false | The orchestrator records them at completion (Implementation Notes) | reject |
| 22 | The liveness step could miss `service.created`, because the subscribe has no acknowledgement and the api resolves its session before joining the hub (implementer's note, orchestrator) | low | It would fail falsely, not pass falsely. The fix is direct: touch the service again (`service.updated`) each second until the subscription hears it | patch (orchestrator) |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean (pre-existing warnings only)
- `pnpm run test` (and with `.env` moved aside) -- expected: all pass
- `pnpm run test:integration` (only postgres, mailpit, migrate up) -- expected: all pass
- `pnpm run test:e2e` -- expected: 10 scenarios pass
- `export COMPOSE_PROJECT_NAME=watchdog-backplane COMPOSE_FILE=docker-compose.yml:docker-compose.backplane.yml COMPOSE_PROFILES=app,backplane; docker compose up --build --wait --wait-timeout 180 && pnpm run test:compose; docker compose down -v` -- expected: pass, and the stack is gone afterwards
