---
title: 'Story 5.12: Fill the 90-day uptime in the public payload'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_commit: '54fea4a6473d96bb263e9cdf9cf34f39431ed42b'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 5.11 writes `uptime_rollups`, but the public payload still returns `uptime.services: []`, so an integrator cannot draw uptime bars.

**Approach:** The status-page repository gets one more read, made inside the page's existing repeatable-read transaction. It returns 90 UTC days for each visible service that has at least one rollup in the window. The shared presenter puts those services in the services list's order. REST and GraphQL both carry the result unchanged.

## Boundaries & Constraints

**Always:**
- The contract is story 5.12's acceptance criteria in epics.md. The rule is DOMAIN, Public status page, "Uptime is shaped now and filled in Epic 5", including the 2026-10-09 per-service rule.
- **Window.** The window is the 90 UTC days `today − 89 .. today`. Today is `(now() at time zone 'UTC')::date`, read in the page's transaction. Days are generated in SQL as `today − 89 + n` over an integer `generate_series(0, 89)`, never a date or timestamp series, which resolves to `timestamptz` and follows the session time zone. They are returned as `YYYY-MM-DD` text. So no date depends on Node's clock or the session time zone. A rollup dated after today or before `today − 89` is ignored.
- **Who is included.** A service is included only when it is visible (`is_public`, not archived, judged in the same snapshot) and has at least one rollup in the window. An included service carries all 90 days, oldest first. A day without a row carries `uptimeRatio: null, worstStatus: null`. Every other day carries the rollup's `uptime_ratio` as a JSON number and its `worst_status`.
- **Order.** `uptime.services` follows the services list's order (`listPublicServices`, which ends at `s.id`). The presenter derives it from that list; it never re-sorts.
- **Snapshot.** The new read is a method on `publicStatusRepository`, called from the existing `withTenantTransaction(..., { isolation: 'repeatable read', readOnly: true })` after the three existing reads. It is not a second transaction.
- **Shape.** The response DTO, the SDL, and the `PublicStatus*` types stay as they are. Only the descriptions that say "filled in Epic 5" are updated. No new GraphQL type, so the contract spec's reachable-type list does not change.
- **Bounds.** The four public bounds (one `publicStatusPage` per operation, the IP rate limit, cache validators, CORS without credentials) are untouched. The ETag still hashes the presented body without `generatedAt`, so a changed rollup changes the tag.
- `foreign-table-allowlist.spec.ts` lists `uptime_rollups` under `FOREIGN['status-page']`.
- Integration tests go in `src/modules/status-page/public-uptime.integration.test.ts`. A new `insertUptimeRollup` fixture in `src/shared/testing/fixtures.ts` upserts a rollup row directly, with counts consistent with its ratio. Days are derived from `utcToday()`. That is one database read per file, so a run that crosses 00:00 UTC can flake. That risk is accepted, as in 5.11; add no other clock reads.
- The Cucumber scenario builds its rollup through the real pipeline. It adds a monitor for "Checkout" with `createMonitor(world.server, cookie, serviceId)`, records a result with `insertCheckResult` dated yesterday from `utcToday()`, and runs `world.server.commandBus.execute(refreshUptimeRollupsCommand({ orgId }))` for that organization only. It then asserts the 90-day shape through `GET /status/:orgSlug`. Steps read no date from Node's clock.

**Never:**
- Read `check_results` from `status-page`, or compute uptime from incidents or maintenance.
- Add a migration, an event, a route, or a GraphQL field or type.
- Reuse an admin type on the public surface, or edit `docs/genesis/*`. ARCHITECTURE 6.1's open "Genesis edit (owner)" entry from 5.11 is not this story's.
- Run an unscoped worker pass in a test.

## I/O & Edge-Case Matrix

Rows are integration tests in `public-uptime.integration.test.ts` unless they say otherwise. "d−n" is n UTC days before today.

| Scenario | Input / State | Expected |
|---|---|---|
| Fill | Visible S with rollups d−0 (1.0, operational), d−5 (0.75, degraded), d−89 (0, major_outage) | S's `days` dates equal exactly d−89 .. d−0, each as `YYYY-MM-DD`; those three days match, with `uptimeRatio` a JSON number (`0.75`, not `"0.75000"`); the other 87 are both null |
| Edge | Rollups at d−89 and d−90 only | d−89 is the first day with values; d−90 appears nowhere |
| No rollup in window | Visible S1 with rollups, S2 with none (only d−90) | S1 in `uptime.services`; S2 absent from it but in `groups` |
| Hidden | Private S3 and archived S4 with rollups | Neither in `uptime.services` nor `groups` |
| Empty | Organization with no rollups | `uptime` deep-equals `{ windowDays: 90, services: [] }` |
| Order | Three visible services in two groups, all with rollups; display orders chosen so list order differs from id order, plus two services tied on display order and name | `uptime.services` ids equal the flattened `groups` service ids in order, and that order is not the ids' sort order |
| ETag | Fetch; upsert S's d−0 ratio 1.0 → 0.5; refetch with `if-none-match` the first tag | 200, not 304; new tag; d−0 is 0.5 |
| Snapshot | Visible S with no rollup. Wrap the uptime method (restored in `finally`) to commit a d−0 rollup for S before calling the original with the outer tx | S is absent from that page's `uptime.services`; present on the next fetch |
| Tenant | Org B has rollups for its own service | Org A's page never lists B's service ids |
| Parity | Same org over REST and GraphQL, selecting `date uptimeRatio worstStatus` | `uptime` deep-equal |
| E2E | Cucumber: a monitor for "Checkout" recorded a failure yesterday, rollups refreshed | Public page: Checkout in `uptime.services` with 90 days ending today; yesterday is `0` and `major_outage`; "Search" absent from `uptime.services` but in `groups` |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/database/public-status.repository.ts` -- add `listPublicUptime(tx)` beside `listPublicServices` (l.93-135, whose visibility `where` it copies). Return the rows `{ serviceId, date, uptimeRatio: number | null, worstStatus: UptimeDayStatus | null }`. postgres.js returns `numeric` as a string, so convert it with `Number`. Order by `service_id, day`. Add `uptime` to `PublicStatusReads` (l.55-59).
- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.handler.ts:69-85` -- add the fourth read in the transaction, and add `uptime` to `PublicStatusPageView` (l.24-30). Update the snapshot comment above it.
- `src/modules/status-page/dtos/public-status-page.present.ts:50` -- replace `services: []`. Walk `services` (query order), and emit `{ serviceId, days }` for each id present in the uptime rows.
- `dtos/public-status-page.response.dto.ts:102-113` and `get-public-status-page.graphql-schema.ts:64-82` -- update only the "filled in Epic 5" wording. `dtos/public-status-page.contract.spec.ts:8-13` -- its header comment ("until then no request carries a day") is stale; update the wording only. No assertion changes.
- `dtos/public-status-page.etag.ts:150-157` -- unchanged; reference only.
- `src/shared/db/foreign-table-allowlist.spec.ts:61-70` -- add `'uptime_rollups'`. A stale-entry check fails if the SQL does not read it.
- `src/modules/status-page/public-status-payload.integration.test.ts` -- its "explicitly empty" test (l.822) still holds, because that org has no rollups. Update its stale "Epic 5 fills this" comment. Add `worstStatus` to `PAGE_SELECTION` so the parity test (l.902) covers it. The snapshot test (l.857-900) is the pattern for the Snapshot row. It resolves `publicStatusRepository` from `app.diContainer` and wraps a method.
- `public-surface-bounds.integration.test.ts:79-119` -- the ETag/304 pattern.
- `src/shared/testing/fixtures.ts:170-225` -- `insertCheckResult`, `utcToday`, `setRollupProgress`. Add `insertUptimeRollup` after them. `createService`, `createServiceGroup`, `archiveService` and `createMonitor` are there too.
- `tests/status-page/public-status.feature` and `.steps.ts` -- add one scenario. Steps already import from `@/shared/...`. Extend the `PublicPage` type with `uptime`. Find how `uptime-rollups.integration.test.ts` executes `refreshUptimeRollupsCommand`, and do the same against `world.server`.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/status-page/database/public-status.repository.ts` -- `listPublicUptime`
- [x] `.../get-public-status-page.handler.ts` -- the fourth read, and the view field
- [x] `src/modules/status-page/dtos/public-status-page.present.ts` -- fill `uptime.services`
- [x] `.../public-status-page.response.dto.ts`, `.../get-public-status-page.graphql-schema.ts`, `dtos/public-status-page.contract.spec.ts` -- descriptions and comments
- [x] `src/shared/db/foreign-table-allowlist.spec.ts` -- the allowlist entry
- [x] `src/shared/testing/fixtures.ts` -- `insertUptimeRollup`
- [x] `src/modules/status-page/public-uptime.integration.test.ts` -- every matrix row except E2E
- [x] `src/modules/status-page/public-status-payload.integration.test.ts` -- `worstStatus` in the selection; the stale comment
- [x] `tests/status-page/public-status.feature`, `.steps.ts` -- the E2E row

**Acceptance Criteria:**
- Given story 5.12's criteria, when the suites run, then each one is proven by a matrix row, and every command under Verification passes.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row.
- The query is not the Design Notes sketch. `foreign-table-allowlist.spec.ts` read the sketch's CTE names and `generate_series` as unowned tables, so the subagent used a subquery and `cross join lateral` over an integer series. The behaviour is the same, and every date is still built from the UTC date.
- The main session rewrote the Order test. As delivered, it asserted that list order differs from id order with random ids, so correct code failed about 1 in 60 runs. The test now gives three ungrouped services display orders in descending id order once their ids are known, and asserts the exact expected list. `updateService` (PATCH) was added to `fixtures.ts` for this.
- `public-uptime.integration.test.ts` ran alone 6 times: 10 of 10 passed each time.
- Review pass 1 led to eight patches (V1, V2, V3, B2, B4, B9, B10, B11), sent back to the same implementation subagent. The main session read the changes. Two entries were deferred (B1, E1).
- Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 251 of 251, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 602 of 602 on the first run, so no reruns.
  - e2e: 4 scenarios, 53 steps.
  - `auth:schema:check` is in sync.
  - No api or worker container was left running.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1 | No test runs the uptime read under a non-UTC session time zone | low | Only 5.11's writer test sets a zone; swapping in `current_date` would pass every 5.12 test. patch (repository test under `Pacific/Kiritimati`) |
| V2/B6 | Nothing tests the window's upper bound | low | No test writes a future-dated rollup; dropping `and today` passes. patch (tomorrow rollup in the no-rollup test) |
| V3/B3 | The SQL visibility filter is untested; the presenter hides its removal | low | `groupUptime` emits only ids in `services`, so deleting `is_public`/`archived_at` passes every test while hidden rows are read anonymously. patch (assert the repository's rows directly) |
| V4 | Today's bar is always null in production, because the refresh writes only closed days | false | `refresh-uptime-rollups.handler.ts:49-89` refreshes through `today`, and 5.11's frozen rule says "It always refreshes through today" |
| B1 | DOMAIN still reads "shaped now, filled in Epic 5", and its 90-day sketch uses session-zone `current_date` with no gap-fill or visibility | low | `DOMAIN.md:1117`, `:1265-1275`. The rule text is still true; the sketch is illustrative and conflicts with DOMAIN's own UTC rule. The fix edits `docs/genesis`. defer (Genesis edit, owner) |
| B2 | The contract spec's new comment denies that a value test exists, and this diff adds one | low | `public-uptime.integration.test.ts` parity test. patch (wording) |
| B4/E2 | `day::text` follows DateStyle | low | Confirmed: under `SQL, DMY` it prints `17/10/2026`. patch (`to_char`) |
| B5 | Tests flake across 00:00 UTC (cached `utcToday`) | low | Accepted risk, stated in Boundaries and in 5.11. rejected |
| E3 | `generatedAt` (Node) can be a UTC day ahead of the window (DB) | low | Only within milliseconds of midnight; no named consumer compares them. rejected |
| B7 | No bound on anonymous payload size (90 days × services) | low | DOMAIN fixes the shape (every included service carries all 90 days). Rate limit and `max-age` bound the cost. Roughly 5 kB per service. rejected |
| B8 | No test that an unchanged refresh keeps the ETag and answers 304 | low | The body is deterministic (ordered query, no clock in it); `public-surface-bounds` already proves same tag twice and 304. rejected |
| B9 | Alias `r` reused; `lateral` references nothing; RLS scoping of the outer join is implicit | low | Readability only, and the fix is a direct correction. patch |
| B10 | The status union is duplicated in the test and fixture | low | `UptimeDayStatus` exists in `status-inputs.ts`. patch |
| B11 | Cucumber "covers 90 days" checks only length and the last date | low | The first day is unchecked; a direct addition. patch (first date). The name-vs-id lookup for Search is consistent with the world's `services` map, so not changed |
| E1 | `ROLLUP_RETENTION_DAYS` below 90 empties older bars | low | Config allows a minimum of 1 (5.11's frozen rule). A misconfiguration that 5.11 approved; raising the minimum changes that contract. defer (Epic 8) |
| E4 | `insertUptimeRollup` accepts a ratio outside 0..1 | low | Test-only fixture; every caller passes 0..1. rejected |

Spec review (before approval), Sonnet reviewer, verified by the main session.

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | `generate_series(date, date, interval)` resolves to `timestamptz`, so the days follow the session time zone | medium | Confirmed on local Postgres (`pg_typeof` = timestamptz). It did not shift in `America/Los_Angeles`, but it contradicts the UTC rule. Integer series stated; sketch rewritten |
| 2 | The Snapshot row passes under read committed if the service already has rollups | medium | Service with no rollup; absent, then present; restored in `finally` |
| 3 | The E2E steps are vague; there is no monitor step | medium | `createMonitor` with the world's cookie, DB-clock date, command bus, and the Search assertion named |
| 4 | Fill and Order assertions are weak (string ratio, first/last only, id order) | low | Exact 90 dates, numeric type, list order ≠ id order |
| 5 | Stale "Epic 5 fills this" comments in the payload test and the contract spec | low | Both updated, wording only |
| 6 | Midnight flake | low | Stated as accepted, as in 5.11 |

## Design Notes

**Days in SQL, order in the presenter.** Generating the series in SQL keeps "today" on the database clock and inside the snapshot. The handler never does date arithmetic, and neither does a renderer. The order comes from the services list the page already printed. A second `ORDER BY` would be one more place for the two lists to disagree.

Sketch (the implementer may restructure it):

```sql
with t as (select (now() at time zone 'UTC')::date as today),
included as (
  select distinct r.service_id from uptime_rollups r
  join services s on s.id = r.service_id and s.org_id = r.org_id
  cross join t
  where s.is_public and s.archived_at is null
    and r.day between t.today - 89 and t.today),
days as (select t.today - 89 + n as day from t cross join generate_series(0, 89) n)
select i.service_id, d.day::text as date, r.uptime_ratio, r.worst_status
from included i
cross join days d
left join uptime_rollups r on r.service_id = i.service_id and r.day = d.day
order by i.service_id, d.day
```

## Verification

**Commands** (only postgres and mailpit running):
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass. Rerun any failure 2–3 times and report every one.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- pass
