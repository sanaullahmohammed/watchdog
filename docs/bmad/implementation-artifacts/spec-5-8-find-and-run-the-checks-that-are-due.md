---
title: 'Story 5.8: Find and run the checks that are due'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '32d7eba85de7dddb59ea0977c5590530d932a5ea'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Monitors can be configured, checked by the 5.4/5.5 adapters and recorded by 5.6/5.7, but nothing selects which monitors are due and runs them.

**Approach:** A per-organization system command, `RunDueMonitorChecksCommand`, selects the due monitors, runs each one's adapter under a process-wide concurrency cap, and records every outcome through `RecordCheckResultCommand`. A unit test that allowlists foreign-table reads per module lands first, because the due query is a new foreign read (`monitoring` → `services`).

## Boundaries & Constraints

**Always:**
- The contract is story 5.8's acceptance criteria in epics.md. The rules come from ARCHITECTURE 6.0.1 (L498–505) and DOMAIN L76, L290, L294 and L1285–1288.
- **Due rule.** A monitor is due when it is enabled, its service's `archived_at is null`, and either `last_checked_at is null` or `last_checked_at + interval_seconds` is at or before `now`. Equality counts as due.
- **The command.** Its payload is `{ orgId, now?: Date }`, modelled on `transitionDueMaintenanceCommand`, and it has no route or resolver. `now` defaults to `new Date()` and is passed into the SQL as a parameter, never read from the database's `now()`.
- **Transaction shape.** The due query runs in its own `withTenantTransaction`, which commits before any check starts. No transaction or pooled connection is held during a network call. Each outcome is recorded by executing `recordCheckResultCommand` on the command bus, so the counters, marker and events stay 5.6's and 5.7's.
- **Failures don't cut others short.** Every due monitor is checked and recorded, even if one record rejects. After all have settled, the command rethrows the first rejection; otherwise it returns `{ checked: number }`. Adapters never throw, but a throw from one is handled the same way as a rejected record. Story 5.9 owns catching that rejection per organization.
- **Dispatch.** A switch on `monitor.type` picks the adapter: `http`, `keyword` (keyword taken from `config.keyword`), `tcp`, or `ssl_expiry` (no `ca`). Each gets `{ timeoutSeconds: monitor.timeoutSeconds, allowedRanges: config.monitor.allowedCidrs }`, read at call time. The adapter's own deadline is the timeout, and the timeout error code is `timeout`. The command adds no timer of its own.
- **Cap.**
  - The config var is `MONITOR_CHECK_CONCURRENCY`: an integer, default 10, minimum 1, maximum 1000. It is exposed as `config.monitor.checkConcurrency` and documented in `.env.example`.
  - The limiter is a module-level instance, so it is process-wide. It reads the cap each time it admits a check, which lets a test lower the cap. A slot is held from the start of the adapter call until its record settles. That way the cap also bounds how many record transactions take pool connections at once (ARCHITECTURE L504, "the connection pool"); no connection is held during the network call itself. `listDue` loads all of an organization's due rows; batching is not in scope.
- **Index.** One migration adds `create index monitors_due_idx on monitors (org_id, last_checked_at) where enabled`, with a `migrate:down`. `20261009120000_create_monitors.sql` promises this index. It is a coarse org-and-enabled filter, and no test asserts a query plan.
- **The allowlist** (`src/shared/db/foreign-table-allowlist.spec.ts`).
  - Inputs and parsing: it parses every non-test `.ts` file under `src/modules/` with the TypeScript parser. The module is the first directory under `modules/`. It reads the literal text of every template tagged `sql` or `<expr>.sql` (including fragments), never untagged templates. It strips `--` comments.
  - Table names: it collects the identifier after `from`, `join`, `into`, `update` and `delete from`. It skips a following `(`, an interpolation, end of text and SQL keywords. That covers `for no key update`, `is distinct from ${x}`, `do update set` and `on conflict`. Quoted identifiers are unquoted, and a leading `public.` is dropped.
  - Maps: it holds an ownership map (module → its own tables, plus a `better-auth` group listing every table in `db/better-auth-schema.sql`) and a per-module foreign allowlist.
  - Allowlist entries:
    - `service` and `status-page`: exactly the foreign reads they have today.
    - `status-page`: also `"organization"`.
    - `monitoring`: `services`.
  - Failure rules: a table named outside a module's own tables and its allowlist fails, and so does a table in no map. The failure message names the module, the table and the file. A case that feeds a synthetic unlisted read proves this. The test also guards that it found at least one file and at least one table.

**Never:**
- Worker wiring, a loop, health or a `src/worker.ts` change; those are 5.9.
- An unscoped worker pass in tests.
- New events, a route, a resolver or a schema.
- Locking or writing monitors outside `RecordCheckResultCommand`.
- Holding a transaction across a check.
- Editing an applied migration, or changing 5.4–5.7 behaviour.
- Ordering assertions by time.

## I/O & Edge-Case Matrix

The suite is `src/modules/monitoring/due-monitors.integration.test.ts`. Its setup:
- Each test runs the command for its own organization.
- Set `config.monitor.allowedCidrs = parseAllowedCidrs('127.0.0.0/8')` before creating monitors, because the create handler checks the target too. Restore it, and `checkConcurrency`, in `after`/`finally`.
- Targets come from `startTestEndpoints()` and always override `createMonitor`'s default:
  - `tcp` and `ssl_expiry` use `127.0.0.1:<port>`, where the `ssl_expiry` port is `new URL(httpsOrigin).port`;
  - `keyword` takes `config: { keyword }`.
- `intervalSeconds` is 60 unless stated. A disabled monitor is created with `enabled: false`.
- Boundary rows pass `now` and set `last_checked_at` through `setMonitorCheckState`.

| Scenario | Input / State | Expected |
|---|---|---|
| Selection | Five monitors: A last checked `now − 60 s` (exactly due), B last checked `now − 59.999 s`, C never checked, D disabled and never checked, and E last checked well past due | A, C and E get one result each; B and D get none. The command returns `{ checked: 3 }` |
| Every type | One `http` (`/ok`), one `keyword` (`/body?keyword=`), one `tcp` (the endpoint port) and one `ssl_expiry` (the `httpsOrigin` host:port) | `http`, `keyword` and `tcp` succeed. `ssl_expiry` fails as untrusted with its fingerprint present, which proves the SSL adapter ran |
| Archived | Service with one enabled and one disabled monitor; archived via `POST /api/v1/services/:id/archive` | Returns `{ checked: 0 }`; no results; each monitor row's `xmin` is unchanged (`recordCheck` leaves `updated_at` alone, so `updated_at` proves nothing) |
| Restored | Same service plus an enabled monitor last checked `now − 10 s`; restored via `/restore`; the command run, then that monitor's `last_checked_at` moved to `now − 60 s` and the command run again | First run: the never-checked enabled monitor is checked and the recent one is not. Second run: the recent one is checked. The disabled one is never checked |
| Cap | `checkConcurrency` 2; five monitors on `/hold?delay=400` | The endpoint's peak in-flight is exactly 2, and all five are recorded |
| Timeout | One monitor with `timeoutSeconds` 1 on `/silent`, alongside two on `/ok` | The silent one records `failure`/`timeout`; the two `/ok` monitors record `success`; the command finishes in under 5 s (`performance.now()`) |
| Record fails | `checkResultRepository.append` is stubbed through `app.diContainer` to throw for one monitor id and call through for the others; restored in `finally` | The command rejects with the stub's error; the other monitors still have their results |
| Tenant | A second organization with a due monitor | Running the command for the first org leaves the second org's monitor unchecked |

</frozen-after-approval>

## Code Map

- `src/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler.ts` -- the shape to copy: action creator, `make*` default export, `init()` registers.
- `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts:25` -- `recordCheckResultCommand({ orgId, monitorId, outcome })`, which returns the result id. Do not change it.
- `src/modules/monitoring/checks/{http,keyword,tcp,ssl-expiry}-check.ts` -- `runHttpCheck(target, opts)` at :243, `runKeywordCheck(target, keyword, opts)`, `runTcpCheck`, and `runSslExpiryCheck` at :59. The options are `HttpCheckOptions` at `http-check.ts:20`. There is no type dispatcher yet.
- `src/modules/monitoring/database/monitor.repository.ts` -- add `listDue(tx, now)`. It joins `services s on s.id = m.service_id and s.org_id = m.org_id`, maps through `monitorMapper`, and orders by `last_checked_at nulls first, id`.
- `src/modules/monitoring/index.ts` -- the `Dependencies` interface; it needs no change, since `commandBus` and `monitorRepository` already exist. Handlers are auto-registered by `src/server/di/index.ts` (`*.handler.ts`).
- `src/config/env.ts:57,103-106` and `.env.example:25-33` -- where `MONITOR_ALLOWED_CIDRS` and the `monitor` block live.
- `src/shared/api/contract/authenticated-surface.spec.ts` -- the walker and `ts.createSourceFile` idiom, including the `__dirname` note.
- Today's foreign reads:
  - `service/database/service-status.repository.ts` reads incident and maintenance tables.
  - `status-page/database/public-status.repository.ts` reads seven tables.
  - `status-page/database/organization.repository.ts` reads `"organization"`.
  - Derive the exact lists from the scan; list nothing that is not read.
- `src/shared/testing/test-endpoints.ts` -- add a delayed-headers route (`/hold?delay=ms`, which answers 200 after the delay) and a `peakInFlight()` counter that `reset()` clears.
- `src/shared/testing/fixtures.ts` -- `createMonitor`, `setMonitorCheckState`, `createCheckResultPartitions`. Add `archiveService` and `restoreService` here, because no helper exists (`monitor.integration.test.ts:258` inlines the archive call).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/db/foreign-table-allowlist.spec.ts` -- the scan, the maps, the synthetic failing case and the guards. Write it first, with `monitoring` → `services` already listed.
- [x] `db/migrations/<timestamp>_add_monitors_due_index.sql` -- the partial index, plus `down`.
- [x] `src/config/env.ts`, `.env.example` -- `MONITOR_CHECK_CONCURRENCY`.
- [x] `src/modules/monitoring/checks/check-limiter.ts` (+ `.spec.ts`) -- the process-wide limiter. The unit spec proves it never admits more than the cap, admits again as slots free, and reads a lowered cap.
- [x] `src/modules/monitoring/checks/run-check.ts` -- the type dispatch.
- [x] `src/modules/monitoring/database/monitor.repository.ts` -- `listDue`.
- [x] `src/modules/monitoring/commands/run-due-monitor-checks/run-due-monitor-checks.handler.ts` -- the command.
- [x] `src/shared/testing/test-endpoints.ts`, `fixtures.ts` -- the route, the counter and the archive/restore helpers.
- [x] `src/modules/monitoring/due-monitors.integration.test.ts` -- every matrix row.

**Acceptance Criteria:**
- Given story 5.8's criteria, when the unit and integration suites run, then each criterion is proven and the allowlist fails on an unlisted foreign table.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row, and reran the new suites: `due-monitors.integration.test.ts` 8 of 8, and the allowlist and limiter specs 8 of 8.
- The limiter is split in two. `checks/check-limiter.ts` is pure (`createLimiter(cap)`), and `checks/process-check-limiter.ts` holds the process-wide instance. A unit spec importing `@/config/env` fails in CI's unit job, which has no `.env`.
- Migration `db/migrations/20261016130000_add_monitors_due_index.sql`.
- The allowlist's `better-auth` group is read from `db/better-auth-schema.sql`. Today's foreign reads are as the Code Map says; no other was found.
- The subagent's first full integration run had one failure, `src/worker-health.integration.test.ts`, "fails the healthcheck when tenant discovery fails"; its message was not captured. It passed twice alone and in a full rerun (541 of 541). It does not touch this change.
- After the review pass 1 patches (same subagent; the main session read them). The main session added one `biome-ignore` to the allowlist spec's synthetic source, whose `${y}` raised a new lint warning. Verification by the main session, 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings; no dependency violations).
  - Unit tests: 239 of 239, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 543 of 543 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps. `auth:schema:check` is in sync.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1/B5 | Nothing proves a slot is held until the record settles | medium | Pre-verified: the cap test counts only HTTP requests at `/hold`, so moving the record outside `checkLimiter.run` passes. patch: test counting concurrent appends |
| V2 | Nothing proves the limiter is process-wide | medium | Pre-verified: the cap test runs one org, so a per-call limiter passes. patch: two orgs run concurrently in the cap test |
| B2/E3 | Only the first rejection is rethrown; the rest are lost | medium | `settled.find(...)` keeps one reason, and 5.9 will log only what it catches. patch: AggregateError when more than one rejects |
| B8 | A stale `FOREIGN` entry silently keeps permitting its table | low | `violations()` checks only unlisted reads; reads will move in 5.13/5.14. patch: every entry must match a read |
| B12/E8 | `peakInFlight` counts every route and `reset()` seeds it with leftovers | low | `reset()` sets `peak = inFlight`; an open `/silent` from a reordered test breaks the exact assertion. patch: count `/hold` only, reset to 0 |
| B6/E7 | FIFO limiter is not fair between organizations | maybe-false (medium if true) | Depends on whether 5.9 runs organizations concurrently. defer to 5.9 |
| B7/E2 | Two overlapping passes check every due monitor twice | maybe-false (medium if true) | The due query claims nothing; 5.9's no-overlap rule covers one process, and genesis is silent on worker replicas. defer to 5.9 |
| B1/E1 | A check waiting for a slot runs on a stale row (disabled, archived, retargeted) | low | Real only when an org's queue outlasts an edit; at the default cap a typical org waits not at all. 5.7 already accepts a disabled monitor's in-flight result. rejected (adds a re-read per check); 5.9 may revisit with its loop |
| V3 | No unit test of `MONITOR_CHECK_CONCURRENCY`'s default and limits | low | env-schema enforces `minimum: 1`; the fix moves the var to its own file plus a spec. rejected (unlikely; more than a direct correction) |
| V4 | Timeout test's `< 5 s` bound cannot show parallelism | low | True; parallelism is proven by the cap test and the row's "others complete" by their results. rejected (cosmetic) |
| B3/E4 | Keyword monitor without a keyword passes forever via `''` | false | `monitor.domain.ts:56` refuses a keyword monitor without `config.keyword` on create and update, the only write paths |
| E5 | `runCheck` has no `default` branch | false | `monitors_type_ck` limits `type` to the four cases and the switch is exhaustive under `tsc` |
| E6 | A cap of 0 or NaN hangs the pass | false | env-schema enforces `minimum: 1`; only a test can write another value |
| B4 | Default cap 10 equals postgres.js's default pool of 10 | low | Records are short transactions and a slot holds a connection only while recording, so the maintenance pass waits milliseconds at worst. rejected (unlikely) |
| B9/E9–E12 | Allowlist blind spots (renamed tag, `unsafe`, comma joins, interpolated names, block comments) and false failures (`extract`, CTEs) | low | No module source uses any of these today (V's grep); false failures fail loudly, which is correct. rejected (unlikely; adds parser complexity) |
| B10 | Raising the cap does not admit waiting tasks until a slot frees | low | True and documented by the comment; the cap does not change at runtime outside tests. rejected (cosmetic) |
| B11 | Handler does not guard `orgId`/`now` | low | System command with no route; the worker passes ids from `"organization"`. rejected (unlikely) |
| B13 | sprint-status says in-progress while the spec says in-review | false | Step 5 sets `review` when presenting, as in 5.7 |

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass, with only postgres and mailpit up. Rerun any failure 2–3 times and report all of them.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- pass
