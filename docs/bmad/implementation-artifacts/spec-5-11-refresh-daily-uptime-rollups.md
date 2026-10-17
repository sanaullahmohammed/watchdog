---
title: 'Story 5.11: Refresh daily uptime rollups'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_commit: 'ac09535aab3c7371844a97f67e3bd95608b6d390'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There are no rollups, so 90-day history could only be read from raw `check_results`. Those are kept for 30 days.

**Approach:** One migration adds `uptime_rollups` and `uptime_rollup_progress`. The monitoring module gets `refreshUptimeRollupsCommand`, run per organization in the worker's maintenance pass before partition maintenance. It refreshes the closed days after the watermark, then yesterday and today, then prunes old rollups and emits `uptime.rollup_refreshed`.

## Boundaries & Constraints

**Always:**
- The contract is story 5.11's acceptance criteria in epics.md. The rules are in DOMAIN: UptimeRollup (with "Which days a refresh covers"), UptimeRollupProgress, the partitioning section, and the daily rollup sketch. ARCHITECTURE 6.1 is also binding.
- **Migration** (`db/migrations/20261017120000_create_uptime_rollups.sql`; copy `monitor_ssl_warnings`'s shape):
  - `uptime_rollups` is laid out as DOMAIN gives it:
    - PK `(org_id, service_id, day)`
    - `org_id` → `"organization"` on delete cascade
    - tenant FK `(service_id, org_id) → services (id, org_id)` on delete cascade
    - CHECK on `worst_status` in `operational`, `degraded`, `major_outage`
  - `uptime_rollup_progress` is `org_id` PK → `"organization"`, `refreshed_through date not null`, `updated_at`.
  - Both tables have RLS enabled, `FORCE`d, and `<table>_org_isolation` with the standard policy. Neither revokes `update` or `delete`.
  - `migrate:down` drops the function and both tables.
  - A `SECURITY DEFINER` function `check_results_retained_from() returns date` returns the lower bound of the oldest `check_results` partition, or null.
    - It has a fixed `search_path` and `timezone = 'UTC'`, and reads partitions the way `drop_expired_check_result_partitions` does.
    - `EXECUTE` is revoked from public and granted to `watchdog_app`.
- **Days** are `(checked_at at time zone 'UTC')::date`. "Today" is `(now() at time zone 'UTC')::date`. The range filter's bounds are UTC midnights: `checked_at >= (from::timestamp at time zone 'UTC')` and `checked_at < ((today + 1)::timestamp at time zone 'UTC')`. So no date depends on the session's time zone.
- **Range.** The refresh reads the progress row P.
  - With P, it refreshes from `least(P + 1, yesterday)`. A P ahead of yesterday, from a clock step, therefore still refreshes yesterday.
  - With no P, it starts at the organization's oldest retained result. When there is none, it starts at yesterday and writes P as yesterday. That covers an organization with no monitors.
  - It always refreshes through today.
  - In the same transaction it sets `refreshed_through = greatest(P, yesterday)`, and writes the progress row only when that value changes.
- **Upsert.**
  - The upsert aggregates as the DOMAIN sketch does: `avg_latency_ms` over successes only, and `worst_status` by failure count.
  - Its `do update` carries a `where` comparing the six aggregates (`total_checks`, `successful_checks`, `failed_checks`, `uptime_ratio`, `avg_latency_ms`, `worst_status`) with `is distinct from` against their `excluded` values. A row whose aggregates did not change is not rewritten.
  - A day with no results writes nothing. The refresh never deletes a row it did not compute. Services and monitors are never hard-deleted, so no row's raw results can vanish other than by retention.
- **Lost range.**
  - With P and a non-null `retained_from` where `P + 1 < retained_from`, the days `P + 1 .. min(retained_from − 1, yesterday)` are lost. That holds whether or not those days had results; after the drop nobody can tell.
  - No P, or a null `retained_from`, means nothing is lost.
  - The command returns the range as `{ from, to }`, or null. The worker logs it at `warn` with `orgId`.
  - Nothing is written for those days.
- **Prune.** The same transaction deletes this organization's rollups with `day < today − ROLLUP_RETENTION_DAYS`.
- **Event.**
  - `src/shared/events/monitor.events.ts` adds `uptimeRollupRefreshedEvent`. It uses `actionCreatorFactory('uptime')`, so its type is `uptime/rollup_refreshed`.
  - The payload is its own type: `{ orgId, from, through, written, pruned }`.
    - `from` is the first day refreshed. `through` is today. Both are `YYYY-MM-DD`.
    - `written` counts rows inserted or changed. `pruned` counts rows deleted.
  - It is emitted after commit, only when `written` or `pruned` is above 0. That way the maintenance pass, every 30 s by default, announces nothing when nothing changed.
- **Config.**
  - `ROLLUP_RETENTION_DAYS` is an integer: default 400, minimum 1, maximum 36 500.
  - It is declared beside `CHECK_RESULTS_RETENTION_DAYS` in `src/config/check-results-env.ts`, with spec coverage.
  - It is exposed as `env.monitor.rollupRetentionDays`.
- **Worker.**
  - `runWorkerPass` runs the refresh for each visited organization in its own try/catch, after that organization's reconciliation and before the partition step.
  - A scoped pass runs it too, because it touches only its own organizations.
  - Each organization keeps one boolean, so it counts once for `every organization failed` when any of its steps failed.
- Tests may run only scoped passes.
- Fixtures go in `src/shared/testing/fixtures.ts`:
  - at least `insertCheckResult(orgId, { monitorId, serviceId, checkedAt, status, latencyMs })`, which ensures the partition first;
  - a `utcToday()` that reads the date from the database once, so every "d−n" is derived from it. A run that straddles 00:00 UTC can still flake, because the handler reads `now()` itself. That risk is accepted.
- Test dates must stay within the last 10 months, or be older than 14. `check-result-partitions.integration.test.ts` owns months −12 to −14.

**Never:**
- Fold incidents or maintenance into rollups.
- Read the Postgres catalog from module SQL, or call a real `dropExpired` with a short retention in a test.
- Edit an applied migration or `docs/genesis/*`.
- Add a route, a GraphQL field, or anything in `status-page` (Story 5.12).

## I/O & Edge-Case Matrix

The rows are integration tests in `src/modules/monitoring/uptime-rollups.integration.test.ts`, and run `refreshUptimeRollupsCommand({ orgId })` unless they say otherwise. "d−n" means n UTC days before today.

| Scenario | Input / State | Expected |
|---|---|---|
| RLS | Migrated | `tenant-rls-coverage` passes; both tables enabled and forced |
| CHECK | Insert a rollup with `worst_status: 'minor'` | Refused with a check violation |
| Aggregates | d−1: 3 successes (100, 200, 300 ms) and 1 failure (null ms) | 4, 3, 1, ratio 0.75000, avg 200, `degraded` |
| Ladder | Days of all successes, all failures, and only failures with null latency | `operational`; `major_outage`; avg null |
| Empty day | Results on d−3 and d−1 only | No d−2 row |
| Unchanged | Refresh twice, no new results | Every rollup row and the progress row keep `updated_at` and `xmin`; the second run emits nothing |
| Midnight | P = d−1 and a d−1 row exist; then a result at d−1 23:59:59.900 is inserted | The d−1 row counts it; today's does not |
| Time zone | Repository refresh in a tenant transaction after `set local time zone 'Pacific/Kiritimati'`; results at d−1 23:30 UTC and d−0 00:30 UTC | One in d−1, one in d−0 |
| Catch-up | P = d−6; results d−5, d−4, d−2 | Rows d−5, d−4, d−2; `refreshed_through` = d−1 |
| No progress | Results d−7 and d−1, no P | Both rows exist; P inserted as d−1 |
| Lost range | P set 18 months back; no partition that old | Returned lost range starts at P+1 and ends before this month; no rows ≤ its end; P = d−1 |
| Before maintenance | `runWorkerPass(app, log, { orgIds, maintainPartitions: true })` with the repo stubbed as the partitions suite does; no P, no rollups, one result on d−3 | The stubbed `dropExpired`, reading through a tenant transaction, sees the d−3 rollup already written |
| Lost range logged | Same pass with P 18 months back | One `warn` with `orgId`, `from`, `to` |
| One org's refresh fails | Stub app (`check-result-partitions` suite): rollup throws for org 1 of 2 | Org 1 logged once; org 2 still refreshed; maintenance still runs; the pass resolves |
| Every org fails | Stub app: rollup throws for both orgs | The pass rejects `every organization failed (2)` |
| Tenant | Orgs A and B with results; refresh A | A's rows only; B has none until B is refreshed |
| SSL | `recordCheckResultCommand`: one success of a valid certificate and one failure of an expired one. Assert both `monitor_ssl_warnings` rows exist first | 2 total, 1 success, 1 failure, `degraded` |
| Prune | P = d−1; rollups at d−401 and d−400, and d−200 with no raw rows | d−401 is gone; d−400 and d−200 stay; event `{ orgId, from: d−1, through: d−0, written: 0, pruned: 1 }` |

</frozen-after-approval>

## Code Map

- `db/migrations/20261016120000_create_monitor_ssl_warnings.sql` -- the template for table, FK, RLS and policy. `20261009130000_create_check_results.sql` holds `drop_expired_check_result_partitions`, which shows how partitions are listed and parsed, plus the security-definer and grant boilerplate.
- `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts` -- the handler shape (`monitoringActionCreator`, `make…({ deps })`, `init` registers). The new handler is `commands/refresh-uptime-rollups/refresh-uptime-rollups.handler.ts`. Awilix auto-registers `*.handler.ts` and `*.repository.ts`.
- `src/modules/monitoring/database/monitor-ssl-warning.repository.ts` -- repository style (`(tx: TenantTransaction, …)`). The new one is `uptime-rollup.repository.ts`.
- `src/modules/monitoring/database/check-result-partition.repository.ts` -- add `retainedFrom()` here, calling the new function on the global `sql`.
- `src/modules/monitoring/index.ts` -- add the new repository and handler to `Dependencies`.
- `src/shared/events/monitor.events.ts` -- event pattern; add the `uptime` factory and the event at the end.
- `src/config/check-results-env.ts` (+ spec), `src/config/env.ts:115-125` -- the config pattern.
- `src/worker.ts:80-147` -- the per-org loop, the partition step (its comment reserves this spot), and the failure tail. Update the comment and the JSDoc.
- `src/modules/monitoring/check-result-partitions.integration.test.ts`
  - Its stub-app test (~:436) throws on an unknown command and asserts that maintenance runs last. Teach it the rollup command, and assert that the rollup comes before maintenance.
  - `stubbed()` (~:380) is the pattern for the "Before maintenance" row.
- `src/shared/db/foreign-table-allowlist.spec.ts:29` -- add `uptime_rollups` and `uptime_rollup_progress` to `OWNED.monitoring`.
- `src/shared/domain/status-inputs.ts:91` -- `UPTIME_DAY_STATUSES`. The CHECK values must match it.
- `src/shared/testing/fixtures.ts` -- `createCheckResultPartitions`, `setMonitorCheckState` (style), `createMonitor`. `src/shared/testing/events.ts` captures events.
- Do not touch `status-page` or `runMonitorPass`.

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/20261017120000_create_uptime_rollups.sql` -- both tables and `check_results_retained_from()`
- [x] `src/config/check-results-env.ts` (+ spec), `src/config/env.ts` -- `ROLLUP_RETENTION_DAYS`
- [x] `src/shared/events/monitor.events.ts` -- `uptimeRollupRefreshedEvent`
- [x] `src/modules/monitoring/database/uptime-rollup.repository.ts`, `check-result-partition.repository.ts` -- refresh, progress, prune, `retainedFrom`
- [x] `src/modules/monitoring/commands/refresh-uptime-rollups/refresh-uptime-rollups.handler.ts`, `src/modules/monitoring/index.ts` -- the command
- [x] `src/worker.ts` -- the step, the lost-range log, the failure count, the comments
- [x] `src/shared/db/foreign-table-allowlist.spec.ts` -- ownership
- [x] `src/shared/testing/fixtures.ts` -- the result and progress fixtures
- [x] `src/modules/monitoring/uptime-rollups.integration.test.ts` -- every matrix row
- [x] `src/modules/monitoring/check-result-partitions.integration.test.ts` -- the stub-app ordering and the two failure rows

**Acceptance Criteria:**
- Given story 5.11's criteria, when the unit and integration suites run, then each criterion is proven by a matrix row, and `pnpm run check` passes.

## Implementation Notes

- A Sonnet subagent implemented the spec. It stopped once on a usage limit and was resumed. The main session read the whole diff against every task and matrix row.
- Three existing tests changed, each for a reason the spec implies:
  - `check-result-partitions` now counts three definer functions.
  - The event-catalog lists in `monitor.integration.test.ts` and `record-check-result.integration.test.ts` include `uptime/rollup_refreshed`.
  - `worker-health.integration.test.ts`'s "some fail, others succeed" case used a made-up organization id. The rollup step writes a progress row whose foreign key refuses it, so the case now signs up a real organization.
- In production a pass gets its ids from discovery. An organization deleted mid-pass fails that one step, which is then logged.
- The subagent's `docker compose up -d` also started the api and worker containers. It stopped them at once.
- Verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 251 of 251, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 587 of 587 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.
  - No child worker was left running.

- Review pass 1 led to eight patches (V1, V2, V3, B4, B6, B9, B12, B13), sent back to the same implementation subagent; the main session read the delta. Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 251 of 251, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 591 of 591 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.
  - No child worker was left running.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1 | No test has a failure with a latency, so dropping the success filter from `avg` passes | low | Every inserted failure has null latency; real HTTP/SSL failures carry one (`http-check.ts:132-142`). patch (new test) |
| V2 | Nothing proves a failed reconciliation still lets the rollup run | low | The stub-app rows fail only the rollup; the `BAD_ORG_ID` cases fail both. patch (stub-app test) |
| V3/B11/E7 | The SSL test takes `checkedAt` from Node's clock and asserts one row | low | Near midnight or a WSL clock step the results fall outside the DB's range. patch (derive from `utcToday`) |
| B4 | The Prune test hard-codes the 400-day default | low | The handler reads `env.monitor.rollupRetentionDays`; a developer `.env` with another value fails the suite. patch (derive from env) |
| B6/E5 | "Kept this many days" but d−0..d−N stay | low | Code follows the frozen rule `day < today − N` and DOMAIN's "older than … are pruned"; only the wording is off. patch (wording) |
| B9 | `oldestResultDay` takes `min` over an expression | low | `min(expr)` can use no index; `min(checked_at)` then convert is a direct correction. patch |
| B12 | Nothing shows a lost range is reported once | low | After the first refresh P = d−1, so a second refresh should return null; untested. patch |
| B13 | Clock-step and two-services-one-day branches untested | low | Neither case appears in the suite. patch (two tests) |
| B1 | ARCHITECTURE 6.1 says two definer functions "and nothing more" | low | `ARCHITECTURE.md:538`; this story adds a third. The fix edits `docs/genesis`, which is the owner's. defer (Genesis edit, owner) |
| B2/E1 | Partition maintenance drops even after an org's rollup failed | false | DOMAIN L402 decides this: a day not rolled up before retention drops it is lost and logged. Blocking drops on any failure would let one failing org stop retention for all |
| B3/E3 | The watermark is read without a lock | low | Identical aggregates either way; the worst case is a duplicate warning and event. The spec claims no serialization (Design Notes). rejected |
| B5 | Nothing stops rollup retention being shorter than raw retention | low | A misconfiguration with no default path to it; a cross-check adds config surface. rejected |
| B7 | The event fires on most passes for active orgs | false | The doc says a pass that changed nothing announces nothing, which holds: today's row changing is a change |
| B8/E2 | An org deleted mid-pass fails the progress FK | low | Logged once, counted for that org only; a guard adds a branch for a rare race. rejected |
| B10 | No CHECK constraints on rollup counts | low | Only the aggregate writes rows; no named harm. rejected |
| B14 | The retained-from function parses partition names | false | Partitions are created only by `create_check_result_partitions`, with names that match; no default partition exists |
| E4 | `retainedFrom` after today gives a reversed range | low | Needs no partition for the current month while older ones were dropped; create runs before drop in one command. Unreachable in practice; adds a branch. rejected |
| E6 | `numeric(6,5)` rounds to 1.00000 above ~200k checks a day | low | DOMAIN fixes the type; at v1 intervals a service needs ~70 monitors to get there. rejected |
| E8 | The lost-range test assumes a partition exists | false | The `check_results` migration creates the current month and the next two, which are never dropped |

Spec review (before approval), Sonnet reviewer, verified by the main session.

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | The event fires every pass; `from`/`through` undefined; the Prune row cannot fail on dates | medium | Defined the fields; emit only when rows were written or pruned; concrete dates in Prune; Unchanged asserts no event |
| 2 | The range filter's bounds are not pinned to UTC | medium | UTC-midnight bounds stated |
| 3 | The failure count can double-count an org; no failure row | medium | Per-org boolean; two stub-app rows |
| 4 | `excluded.*` would compare timestamps too | medium | The six aggregates are named |
| 5 | Null `retained_from`, P ahead of yesterday, `to` cap, "lost" for empty days | low | Each stated |
| 6 | No-P with no results; the oldest-result scan | low | Stated; scan noted in Design Notes |
| 7 | Cascaded deletes leave stale rollups | false | Services and monitors are never hard-deleted (`revoke_service_delete`, `create_monitors.sql:88`); an org delete cascades the rollups too |
| 8 | Midnight flakiness | low | `utcToday()` from the DB; residual risk accepted |
| 9 | The Before-maintenance row lacks preconditions | low | No P, no rollups, read through a tenant transaction |
| 10 | The SSL row cannot fail unless the warnings really exist | low | Assert the warning rows first |
| 11 | Progress row churn | low | Written only when it advances; Unchanged covers it |
| 12 | `migrate:down` | low | Stated |
| 13 | No test makes the CHECK fail | low | CHECK row added |
| 14 | The lost-range end depends on another suite's partitions | low | Already loose; kept |

## Design Notes

**Why a single statement, not day by day.** One `insert … select … group by day` covers the whole range in one transaction, together with the watermark update. Either every day after P is refreshed and P advances, or nothing changes. That is what "oldest first" protects: the watermark never passes a day that was not refreshed. Partition pruning keeps an old P cheap.

**Why the oldest partition, not the retention rule.** Catch-up runs before maintenance. So after an outage, a partition past retention still exists when catch-up reads it, and its days are rolled up rather than reported lost. Only the partitions that actually exist say what is retained. A plain catalog read would trip the table allowlist, and ARCHITECTURE 6.1 routes partition knowledge through owner functions, so it is one more of those.

**The oldest-result read.** With no P, finding the oldest result scans every retained partition, because no index leads with `(org_id, checked_at)`. It runs once per organization, when the progress row is first written. That is fine at v1's scale.

**Concurrency.** The worker's maintenance loop is single-flight. Two refreshes of one organization would compute the same aggregates, and `greatest` keeps the watermark from moving back. No lock is taken, and nothing here claims more.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass, with only postgres and mailpit up. Rerun any failure 2–3 times and report all of them.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- pass
