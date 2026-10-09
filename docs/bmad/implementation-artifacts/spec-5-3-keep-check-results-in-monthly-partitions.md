---
title: 'Story 5.3: Keep check results in monthly partitions'
type: 'feature'
created: '2026-10-09'
status: 'done'
baseline_commit: '8519c1e03f0f03ccaddda76aac2f59db9bf0db8c'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Checks (5.4 onward) need somewhere to store results. FR12 wants them append-only, partitioned by month, and expired by dropping partitions according to `CHECK_RESULTS_RETENTION_DAYS`. The worker runs as `watchdog_app`, which may not run DDL (ARCHITECTURE 6.1, M5).

**Approach:** One migration creates `check_results` and two owner-owned `SECURITY DEFINER` functions, one to create partitions and one to drop expired ones. `MaintainCheckResultPartitionsCommand` calls both once per worker pass, after the per-organization work.

## Boundaries & Constraints

**Always:**
- Story 5.3's seven acceptance criteria (epics.md) are the contract. DOMAIN CheckResult, partitioning (M4, M8) and ARCHITECTURE 6.1 (M5) are the rules.
- Columns as DOMAIN, with `metadata jsonb not null default '{}'` and `created_at timestamptz not null default now()`. `org_id` references `"organization"` with `on delete cascade`. Tenant FKs are `(monitor_id, org_id)` to `monitors (id, org_id)` and `(service_id, org_id)` to `services (id, org_id)`, both `on delete cascade` as in `incident_updates`. DOMAIN's three suggested indexes go on the parent, verbatim, including `check_results_failure_idx`'s `where status = 'failure'`; each partition gets its own copy, which is DOMAIN's "local to partitions".
- The parent gets RLS enabled, `FORCE`d, and `check_results_org_isolation` (`using` and `with check` on `current_setting('app.current_org_id', true)`). `revoke update, delete on check_results from watchdog_app`.
- `create_check_result_partitions(p_from date default null) returns integer`, the number created. It covers `least(month of p_from, current month)` through current month + 2; a mid-month or future `p_from` is truncated to its month. Months are UTC, bounds are `make_timestamptz(y, m, 1, 0, 0, 0, 'UTC')` rendered with `%L`, and names are `check_results_YYYY_MM` rendered with `%I`. Each new partition gets `revoke all ... from public, watchdog_app`, RLS enabled and forced, and `check_results_YYYY_MM_org_isolation` with the parent's expressions, all in the same call. A `p_from` more than 13 months before the current month is refused. That reaches the 400-day rollup window and stops `watchdog_app` from creating partitions without bound. A partition that exists is skipped before any DDL, so a steady-state pass takes no table lock.
- `drop_expired_check_result_partitions(p_retention_days integer) returns integer`, the number dropped. Null, 0 or a negative value raises. It reads partition names from `pg_inherits`, acts only on those matching `^check_results_\d{4}_\d{2}$`, and rebuilds each name with `format('%I')` from the parsed year and month, so nothing read from the catalog is executed as text. The upper bound is computed from that parsed month (start + 1 month); a partition is detached and dropped when that bound is `<= now() - p_retention_days days`.
- Both refusals raise SQLSTATE `22023` (invalid_parameter_value); the repository and command let it through, and tests assert the code, not the text.
- Both functions: `security definer`, `set search_path = pg_catalog, pg_temp`, `set timezone = 'UTC'`, `set lock_timeout = '3s'` (creating a partition takes `ShareRowExclusiveLock` on `services` through the FK, and detach locks the parent, so a wait must fail rather than stall writers), every object schema-qualified (`public.`), and `pg_advisory_xact_lock` on one shared key so two workers cannot race. `revoke execute on function <name>(<argtype>) from public`, then grant it to `watchdog_app`. The migration calls `create_check_result_partitions()` once, so inserts work before the first pass.
- `runWorkerPass` runs the command after the organization loop, once, with `env.monitor.checkResultsRetentionDays`. A failure is logged at `error` with `err`; the organization work has already run, and the pass then rejects with a message that carries no cause (as the existing rejections do), so a failure that persists past `WORKER_PASS_OVERDUE_MS` turns the healthcheck unhealthy. Decided by the owner, 2026-10-09. When `orgIds` is passed, maintenance is skipped unless `maintainPartitions: true`, because it is global DDL and the suites share one database. The worker never passes either option.
- `CHECK_RESULTS_RETENTION_DAYS`: `Type.Integer({ default: 30, minimum: 1 })`, declared in a small module that `env.ts` composes, as it does with `auth-env`. That lets a unit spec read the default with no `.env`. Add it to `.env.example`.
- Months 13 and 12 back belong to this suite's retention test alone. It creates from 13 back and passes a retention whose cutoff falls mid-month 11 back, so only -13 and -12 expire. Any other suite stores results 10 months back or newer, and no test assumes a month exists unless its own fixture call created it.

**Never:** an edit to an applied migration; a `text` or identifier argument on either function; a row-level `DELETE`; a default partition; the worker holding owner credentials; `withTenantTransaction` in this command; a check-result insert command or repository (5.6).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First pass | migrated database (may already hold them) | current month + 2 exist; no assertion on the count | N/A |
| Second pass | partitions exist | returns 0 | N/A |
| Earlier start | `p_from` mid-month, 13 months back | that month onward exists | N/A |
| Too early | `p_from` 14 months back | nothing created | `22023` |
| Retention | partitions -13 to -11; cutoff mid -11 | -13, -12 dropped (one held a row); -11 kept | N/A |
| Bad retention | 0, -1, null | nothing dropped | `22023` |
| Direct partition access | app selects or inserts into a partition | refused | 42501 |
| Update or delete | app, own tenant transaction | refused | 42501 |
| Maintenance fails | repository stubbed to throw | error logged with `err`; organization work done; pass rejects | logged |
| Scoped pass | `{ orgIds }` only | maintenance not run | N/A |
| Every org fails | organization command stubbed to throw, `maintainPartitions: true` | maintenance still runs once; pass rejects as today | logged |

</frozen-after-approval>

## Code Map

- `db/migrations/20261009120000_create_monitors.sql` -- dbmate format, RLS block, naming; new file `db/migrations/20261009130000_create_check_results.sql`
- `db/migrations/20260910180503_create_incident_updates.sql:32-48` -- append-only revoke precedent; a down migration grants back
- `src/shared/db/tenant-rls-coverage.integration.test.ts:23-42` -- relkind `r`/`p` with `org_id`, so each partition needs RLS, FORCE and a policy; `tenantForeignKeys` needs `org_id` in every tenant FK. Must pass unchanged
- `src/shared/db/postgres.ts` -- default `sql` (watchdog_app, global connection) for the partition repository; `src/shared/db/tenants.ts` is a non-tenant query precedent
- `src/modules/maintenance/commands/transition-due-maintenance/transition-due-maintenance.handler.ts` -- worker-only command shape (`actionCreator`, factory, `init` registers)
- `src/modules/monitoring/index.ts` -- add `checkResultPartitionRepository` to `Dependencies`; DI loads `*.repository.ts` by name
- `src/worker.ts:43-108` -- `runWorkerPass`; insert after the loop and before the "every organization failed" throw. Rollups (5.11) will go before it
- `src/config/env.ts`, `src/config/auth-env.ts` -- composition precedent; add `monitor.checkResultsRetentionDays`
- `src/server/error-logging.integration.test.ts:157-175` -- stub a DI repository method via `app.diContainer.resolve`, restore in `finally`
- `src/shared/db/runtime-role.integration.test.ts:78` -- `postgres(ownerDatabaseUrl(), { max: 1 })` when owner identity is needed
- `src/shared/testing/fixtures.ts` -- `createService`, `createMonitor`; a `createCheckResultPartitions(from)` helper goes here

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/20261009130000_create_check_results.sql` -- table, indexes, RLS, revokes, two functions, execute grants, initial call; down drops functions and table
- [x] `src/config/check-results-env.ts` (+ `.spec.ts`), `src/config/env.ts`, `.env.example` -- retention setting; spec proves default 30 and refuses 0 and 1.5
- [x] `src/modules/monitoring/database/check-result-partition.repository.ts` -- `createPartitions(from?)`, `dropExpired(retentionDays)`
- [x] `src/modules/monitoring/commands/maintain-check-result-partitions/maintain-check-result-partitions.handler.ts` -- `{ retentionDays }` in, `{ created, dropped }` out
- [x] `src/worker.ts` -- the step and the `maintainPartitions` option; log at info when anything was created or dropped
- [x] `src/shared/testing/fixtures.ts` -- the partition helper; safe under concurrent files through the advisory lock and skip-if-exists
- [x] `src/modules/monitoring/check-result-partitions.integration.test.ts` -- every AC and matrix row; for AC2, functions in `public` owned by the owner that `watchdog_app` can execute are exactly these two (filter on `pronamespace`: the owner is the bootstrap superuser and owns all of `pg_catalog`), `prosecdef`, `proconfig` has the search_path, argument types are `date` and `int4`, and neither `prosrc` contains `delete`
- [x] `AGENTS.md` -- one sentence in the concurrent-tests pitfall: a scoped pass skips partition maintenance, and a test passes a retention that spares recent months

**Acceptance Criteria:** story 5.3's seven criteria in epics.md, each proven by the named tests. `tenant-rls-coverage.integration.test.ts` passes unchanged.

## Implementation Notes

- Implemented by a Sonnet subagent from this spec; the main session read the whole diff against every task, AC and matrix row.
- The drop function runs `drop table` on each expired partition rather than `detach partition` followed by `drop table`. Dropping an attached partition removes it from the parent in the same statement. Measured on PG17: a plain drop locks only `check_results` (ACCESS EXCLUSIVE). Detach first converts the partition's foreign keys into standalone ones, and dropping those then takes ACCESS EXCLUSIVE on `"organization"`, `monitors` and `services`. That deadlocked concurrent suites in the subagent's runs, and its workaround locked all four tables with `nowait` retries. The workaround is removed. No rows are deleted either way.
- Creating a partition still deadlocked: it holds ACCESS EXCLUSIVE on `check_results` and then wants SHARE ROW EXCLUSIVE on `"organization"`, `services` and `monitors`, while another suite's cleanup `delete from "organization"` holds those and cascades into `check_results` (postgres log, 2026-10-09 19:05). The victims were other suites' `after` hooks, which then never closed their pools, so nine files hung for about 30 minutes. `lock_check_results_for_ddl(p_for_create boolean)` now takes every lock either function needs with `nowait` before its first DDL. A refused attempt releases what it got (its exception block is a subtransaction) and retries every 0.1 s, up to 50 attempts, then raises `55P03`. Neither function ever waits while holding a table lock. The helper is owner-only, with no grant to `watchdog_app`.
- The first-pass and second-pass tests go through `maintainCheckResultPartitionsCommand` with a 400-day retention, so they exercise the worker's own path and drop nothing.
- Review pass 1 patches (same subagent, re-engaged; the main session made the worker-shape stub strict):
  - The advisory lock is now `lock_check_results_maintenance()`, an owner-only `pg_try_advisory_xact_lock` loop of up to 100 × 0.1 s. A second caller no longer fails on the 3 s `lock_timeout` while the first retries.
  - `CHECK_RESULTS_RETENTION_DAYS` has a `maximum` of 36 500.
  - The `runWorkerPass` docstring is updated, and the worker uses the exported result type.
  - The AGENTS sentence is corrected: a `maintainPartitions: true` test stubs the repository.
  - New tests:
    - A no-options pass on a stub app proves the worker's own call shape runs maintenance once, last, with the configured retention.
    - The retention test goes through the command.
    - Two concurrency tests: creation holds nothing on `check_results` while it waits, and a steady-state pass takes no table lock.
    - Tenant isolation is checked through the parent.
  - Fixes to existing tests: the refused-start test asserts the partition count is unchanged, and test months come from the database clock.
- Verification after pass 1 (main session, 2026-10-09): check clean (11 pre-existing warnings, none in touched files); unit 205/205, and 205/205 with `.env` moved aside; integration 442/442 in three consecutive runs, no reruns needed, no deadlocks in the postgres log; e2e 42/42 steps; auth:schema:check in sync. Before the lock fix, one full run hung on the deadlock above; it is recorded here, not rerun.
- `src/config/check-results-env.ts` holds the setting so `check-results-env.spec.ts` can read the default without `.env`.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1 | The worker's own unscoped call shape is never shown to run maintenance | medium | Every test passes `orgIds`; narrowing the condition to `maintainPartitions === true` keeps the suite green. patch (stub-app pass with no options; asserts once, last, configured retention) |
| V2 | Command drop path and retention argument untested | medium | Retention test calls the SQL function directly; worker stub ignores its argument. patch (retention test through the command; V1 test checks the retention) |
| V3/B3/E13 | No concurrency test behind the deadlock fix | medium | AGENTS requires one for a cannot-race claim; the deadlock is in the postgres log of 2026-10-09 19:05. patch (two-transaction tests: missing month while `organization` is held; steady state while `monitors` and `check_results` are held) |
| V-o1/E8 | Advisory lock wait is bounded by `lock_timeout` 3 s while the holder may retry for 5 s or more | medium | `lock_timeout` applies to advisory-lock waits. patch (try-lock loop helper) |
| B2 | New AGENTS sentence tells a test to pass a retention that `runWorkerPass` cannot take | medium | `runWorkerPass` always reads `env.monitor.checkResultsRetentionDays`. patch (a spec task added the sentence, so correcting it completes that task rather than editing agent context unprompted) |
| B4 | `runWorkerPass` docstring is stale about when a pass rejects | low | Maintenance failure now rejects a pass where every organization succeeded. patch |
| B8 | Worker types the command result inline | low | Neighbouring calls use their exported result types. patch |
| B10 | No behavioural tenant-isolation check through the partitioned parent | low | Only `rows.length >= 1`; the coverage suite checks that a policy exists, not that it isolates. patch |
| B11 | Failure test name claims an order it does not check | low | patch (rename; the V1 test proves the order) |
| E1 | Unbounded retention overflows `::int` | low | Direct correction. patch (`maximum: 36_500`) |
| E10 | "Too early" test assumes month -14 absent | low | A partition left by an aborted run in an earlier month becomes -14. patch (assert the partition count is unchanged) |
| E11 | Test months come from the JS clock, functions from the DB clock | low | Flakes at a UTC month boundary or under WSL2 clock steps (AGENTS). patch (derive months from the DB) |
| B1 | Genesis documents say "detaches and drops"; the code only drops | false | `drop table` on an attached partition removes it from the parent in the same statement, so the documented outcome holds. The reason for not issuing a separate DETACH is in Implementation Notes. |
| B5 | Maintenance failure fails the pass, coupling health to lock availability | false | Decided by the owner, 2026-10-09 (frozen block). |
| B6 | Discovery failure skips maintenance | low | A discovery failure is a database fault that maintenance would also meet; the step must follow the organization loop for 5.11. rejected (unlikely, adds a branch) |
| B7 | Fixture duplicates the repository call | low | `src/shared` cannot import a module (dependency-cruiser); both send one SQL call. rejected |
| B9 | Handler skips `assertMatchesSchema` | false | Worker-only commands have no request schema (`transition-due-maintenance.handler.ts` precedent); env validates the value as an integer and the function refuses < 1. |
| B12 | No tests for an insert outside every partition or a cascade across partitions | low | No default partition is a spec decision; FK cascade is Postgres behaviour. rejected |
| B13 | sprint-status moves 5.2 to done | false | The owner asked for it on this branch; 5.3 moves to review at step 5. |
| E2 | A create failure skips the drop | low | The pass rejects and the healthcheck surfaces persistence. rejected (adds a branch) |
| E3 | A same-named unattached table counts as existing | false | Only the owner can create tables; `watchdog_app` has no DDL. |
| E4 | No default partition, so an out-of-range insert fails | false | Spec Never list; ARCHITECTURE keeps two months ahead. |
| E5 | `service_id` is not tied to the monitor's service | low | Written by 5.6 from the monitor row; DOMAIN owns the constraint. rejected (needs a DOMAIN decision; noted for 5.6) |
| E6 | Negative `latency_ms` allowed | low | DOMAIN gives no range; adding one is a DOMAIN decision. rejected |
| E7 | Year 0000 aborts the drop | false | Only the create function names partitions, from dates within 13 months. |
| E9 | A compose `worker` running against the test database drops this suite's months | maybe-false | Pre-existing: any unscoped worker already breaks the suites (AGENTS). defer |
| E12 | An invalid `Date` gives RangeError, not 22023 | low | Test-only caller. rejected |
| E14 | Claim "calls both once per pass" fails when create fails | low | Same as E2. rejected |

## Design Notes

The maintenance step runs after the organization loop, so 5.11's rollup step can go before it and a day is rolled up before its raw rows are dropped (ARCHITECTURE 6.1, DOMAIN line 402).

The skip on scoped passes keeps one test file from dropping partitions another is writing. Failure tests stub the repository instead of dropping real partitions.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `pnpm run test:integration` -- pass (rerun failures 2–3× per AGENTS clock-skew rule; report all)
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
