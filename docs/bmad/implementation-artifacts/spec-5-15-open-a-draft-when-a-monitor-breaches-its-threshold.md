---
title: 'Story 5.15: Open a draft when a monitor breaches its threshold'
type: 'feature'
created: '2026-10-17'
baseline_commit: '56efb23a44e126388507296ca0cae1ad310e6f90'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A monitor that reaches its failure threshold emits `monitor.threshold_breached`, but nothing listens. No draft incident is proposed, so an operator finds the outage late (FR13, DOMAIN M2 step 5).

**Approach:** The `incident` module subscribes to `monitor.threshold_breached` through `src/shared/events/` and runs a new system command, `createDraftFromMonitorCommand`. The command inserts the draft, its `critical` impact on the monitor's service, and a `draft` timeline entry in one tenant transaction, then emits `incident.draft_created`. A new migration adds the monitor foreign key, `origin_failure_episode`, and `incidents_monitor_episode_uk`. The indexes make a repeat a silent no-op.

## Boundaries & Constraints

**Always:**
- The contract is story 5.15's acceptance criteria in epics.md. The rules are in DOMAIN: Incident (the deduplication invariant, and one proposal per failure episode) and the Consecutive-failure rule, steps 5-7.
- **Migration** `db/migrations/20261017150000_incidents_monitor_origin.sql`:
  - `add column origin_failure_episode integer` (nullable).
  - Before the FK: `update incidents i set origin_monitor_id = null where origin_monitor_id is not null and not exists (select 1 from monitors m where m.id = i.origin_monitor_id and m.org_id = i.org_id)`. Comment it: rows written before monitors existed (test inserts with made-up ids; 2 in the local database) name no monitor, and the owner is a superuser in Compose and CI, as `20261017130000` notes.
  - `constraint incidents_origin_monitor_fkey foreign key (origin_monitor_id, org_id) references monitors (id, org_id) on delete set null (origin_monitor_id)`.
  - `create unique index incidents_monitor_episode_uk on incidents (org_id, origin_monitor_id, origin_failure_episode) where origin_failure_episode is not null`.
  - Down drops the index, FK and column; the nulled ids are not restored. Add no CHECK pairing the two columns, because set-null would violate it; an episode left beside a null monitor is harmless, since null monitor ids never collide in the index.
- **Command** `createDraftFromMonitorCommand`: payload `{ orgId, monitorId, serviceId, monitorName, failureEpisode }`, result `string | null` (the new id, or null when one already exists).
  - Validate first: `assertUuid` on `monitorId` and `serviceId`. `failureEpisode` must be an integer ≥ 1, otherwise `ArgumentInvalidException` (`@/shared/exceptions`), the type `assertUuid` also throws.
  - Build the entity with a new `incidentDomain.proposeDraft`: `assertTransition(null, 'draft')`, `source: 'monitoring'`, impact `critical`, affected `[{ serviceId, impact: 'critical' }]`, title `Monitor failure: <monitorName>`, `createdByUserId: null`, `startedAt` now.
  - In one `withTenantTransaction`, call `incidentRepository.insertDraftIfAbsent`. Only when it created a row, call `appendUpdate` with status `draft`, `timelineEntryMessage(null, null, 'draft')` and `createdByUserId: null`.
  - After commit, emit `incidentDraftCreatedEvent` only if created. Never emit `incident.created` or `incident.update_posted`.
- **`insertDraftIfAbsent`** first locks the monitor's open incidents: `select id from incidents where origin_monitor_id = $m and status <> 'resolved' for no key update`. A confirm in flight holds that lock (`findById` with `lock: 'update'`), so this waits for it, and the insert's fresh statement snapshot sees the committed status. **Race fix (owner, 2026-10-17, review pass 1):** chosen over a new unique index (DOMAIN change) and over accepting the race. Then one statement: `insert into incidents (...) select ... where not exists (select 1 from incidents where origin_monitor_id = $m and status in ('investigating','identified','monitoring')) on conflict do nothing returning id`. The bare `on conflict do nothing` covers both partial indexes without aborting the transaction. The impact row is inserted only when an id came back, mapping a 23503 to `UnknownAffectedServiceError` as `insert` does; the transaction rolls back whole and the event handler logs it.
- **Event handler** in the same slice: `eventBus.on(monitorThresholdBreachedEvent.type, …)` maps the payload to the command and runs it through `commandBus.execute`. It returns the promise, and on a rejection it logs `{ err, event, orgId, monitorId }` without rethrowing, the way `recompute-service-status.event-handler.ts` does. The slice also registers the command so 5.16's reconciliation can reuse it.
- `IncidentEntity`, `IncidentModel`, the mapper and `insert` gain `originFailureEpisode` (null for declared incidents). DTOs, SDL and presenters do not change.
- `incident.draft_created` payload: `IncidentEventPayload & { originMonitorId: string; originFailureEpisode: number }`. The service status recompute does not subscribe to it, because a draft is not a status input.
- Test helpers go in `src/shared/testing/fixtures.ts` (Constraint 9).
- **Spec size (owner, 2026-10-17).** Kept as one story above 1600 tokens: every matrix row tests the one handler this story adds.

**Never:**
- Import `src/modules/monitoring` from `src/modules/incident`, or read `monitors` from incident SQL. The name and service come from the event.
- Confirm, dismiss or edit a draft automatically. Subscribe to nothing besides `threshold_breached`, so `monitor.recovered` and `ssl_expiry_warning` do nothing.
- Edit an applied migration's DDL, or `docs/genesis`.
- Run a worker pass in tests.

## I/O & Edge-Case Matrix

Tests go in the new `src/modules/incident/monitor-draft.integration.test.ts`. It builds its own app, one organization of its own, one public service, and monitors from `createMonitor`. A "breach" means emitting `monitorThresholdBreachedEvent` directly for a real monitor and then calling `drain()`. "Record" means the fixture below, which goes through `RecordCheckResultCommand`; the Dismissed, Recover, FR13, SSL and Recovered rows record. Event assertions filter to the row's own monitor or incident ids, after `drain()`.

| Scenario | Input / State | Expected |
|---|---|---|
| First breach | Breach at episode 1 | One incident: status `draft`, `source: monitoring`, impact `critical`, the origin monitor and episode set, no creating user, title `Monitor failure: <name>`. One impact row at `critical`. One timeline entry: status `draft`, created by no one, with the default message. Exactly one `incident/draft_created`, and no `incident/created` or `incident/update_posted`. |
| Repeat / concurrent | Same episode emitted again; two emitted before one `drain()` | Still one incident and one `draft_created` |
| Next episode while the draft is open | Breach at episode 2 | No second draft (the draft index) |
| Confirmed and unresolved | Confirm through the API, then breach at episode 2 | No draft. After resolving, a breach at episode 3 does draft. |
| Dismissed | Record failures to `failing` (which drafts), dismiss through the API, then breach the same episode again | No draft. Record two more failures: `consecutive_failures` grows, and the service's status stays what it was before dismissal (not `operational`). |
| Recover, breach again | Record a success, then threshold failures | A new draft with the next episode |
| Not public, not a status input | Open draft, then disable the monitor (PATCH `enabled: false`) | `GET /status/:slug` lists no draft. The service status is `operational`. |
| FR13 | Threshold 3. Record 3 failures, then a 4th | Exactly one draft, with episode = `monitors.failure_episode`, still `draft`. Exactly one `draft_created`. No `confirmed`, `dismissed` or `state_changed`. |
| SSL warning | `ssl_expiry` monitor, `warnDays` 14, a successful outcome expiring in 7 days | `monitor/ssl_expiry_warning` emitted. No incident with that origin. |
| Recovered | A draft, then a recorded success | `monitor/recovered` emitted. The draft's row is identical, including `updated_at`. No incident events. |
| Human decision | Confirm one monitor-born draft, dismiss another | Confirm emits `confirmed` and never `resolved` or `dismissed`. Dismiss emits `dismissed` and never `resolved` or `confirmed`. |
| Confirm in flight | A draft at episode 1. A held tenant transaction locks it `for no key update` and sets `investigating` without committing. Meanwhile the command runs for episode 2. | The command has not settled 300 ms later. After the held transaction commits, it resolves `null`, and the monitor still has one incident, `investigating`. |
| Schema | `pg_constraint`, `pg_indexes` | The FK is on `(origin_monitor_id, org_id)` with `confdeltype = 'n'`, `incidents_monitor_episode_uk` matches DOMAIN, and `incidents_monitor_draft_uk` remains |

</frozen-after-approval>

## Code Map

- `db/migrations/20260910175009_create_incidents.sql`
  - `origin_monitor_id uuid` (l.24) has no FK.
  - `incidents_monitor_draft_uk` (l.46-48) stays.
- `db/migrations/20261009120000_create_monitors.sql:25` -- `monitors_id_org_uk` is the FK target.
- `db/migrations/20260910171444_tenant_scoped_foreign_keys.sql:26-29` -- the `on delete set null (col)` precedent.
- `src/shared/db/tenant-rls-coverage.integration.test.ts:58-107` -- needs `org_id` in the FK. It does not check the delete action.
- `src/shared/events/monitor.events.ts:10-15,55-58`
  - The threshold payload is `{ orgId, monitorId, serviceId, monitorName, failureEpisode }`.
  - It is emitted at `record-check-result.handler.ts:139-144`, only on entering `failing`.
- `src/shared/events/incident.events.ts` -- add `incidentDraftCreatedEvent = incidentEventCreator<…>('draft_created')`, so the type is `incident/draft_created`.
- `src/modules/incident/domain/incident.domain.ts` -- add `originFailureEpisode` to the entity, and `proposeDraft` beside `declareIncident` (which sets null).
- `src/modules/incident/domain/incident-timeline.ts:28` -- the default `draft` message already exists.
- `src/modules/incident/incident.mapper.ts`, `database/incident.repository.ts:63-100` (`insert`), `database/incident.repository.port.ts` -- add the column and `insertDraftIfAbsent(tx, entity): Promise<boolean>`.
- `src/modules/incident/commands/create-incident/create-incident.handler.ts` -- the handler shape: action creator from `@/modules/incident`, `init()` registers.
- `src/modules/service/commands/recompute-service-status/recompute-service-status.event-handler.ts` -- the event-handler shape.
- `src/server/di/index.ts:36-52` loads `*.{handler,event-handler}.ts` automatically, so the new files need no wiring. Their names are `createDraftFromMonitorHandler` and `createDraftFromMonitorEventHandler`.
- `src/modules/incident/commands/transition-incident/transition-incident.handler.ts` -- `draft→investigating` emits `state_changed` then `confirmed`. `draft→resolved` emits `state_changed` then `dismissed`. No change.
- `src/shared/domain/status-inputs.ts:128-132`, `public-status.repository.ts:209` -- both exclude drafts already.
- `src/shared/db/foreign-table-allowlist.spec.ts` -- no change, because incident SQL never names `monitors`.
- `src/modules/incident/declare-incident.integration.test.ts:217-253` inserts a random `origin_monitor_id`, which the new FK refuses. Give it a real monitor from `createMonitor`. While the file is open, replace its `const ORIGIN` (l.16) with `TEST_ORIGIN`, and change the deferred-work "23 test files" entry to 22.
- `src/shared/testing/fixtures.ts` -- add:
  - `recordCheckOutcome(app, orgId, monitorId, outcome: CheckOutcome<object>)`, which imports `recordCheckResultCommand` from monitoring. A testing helper is a composition point like `src/worker.ts`, and `no-cross-module-deps` binds only `src/modules/*`.
  - `failureOutcome()` and `successOutcome(metadata?)`, from the shapes in `ssl-expiry-warning.integration.test.ts:45-82`.
  - `transitionIncident(app, cookie, id, status)`. None is shared today; the local `transition` helpers in other suites may stay.
- `src/shared/testing/events.ts` -- `capturingTypes`.
- `src/modules/monitoring/record-check-result.integration.test.ts:55-71,295` -- recording a failure, and the threshold override.
- `src/modules/incident/incident-concurrency.integration.test.ts:197-260` -- the held-lock pattern for the Confirm in flight row: `released` and `locked` promises, a 300 ms not-settled check, and a `finally` that always releases.

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/20261017150000_incidents_monitor_origin.sql` -- column, FK, index; down
- [x] `src/shared/events/incident.events.ts` -- `incidentDraftCreatedEvent`
- [x] `src/modules/incident/domain/incident.domain.ts`, `incident.mapper.ts`, `database/incident.repository{,.port}.ts` -- `originFailureEpisode`, `proposeDraft`, `insertDraftIfAbsent`
- [x] `src/modules/incident/commands/create-draft-from-monitor/create-draft-from-monitor.handler.ts`, `.event-handler.ts` -- the command and the subscription
- [x] `src/modules/incident/domain/incident.domain.spec.ts` (new) -- a unit test for `proposeDraft`
- [x] `src/shared/testing/fixtures.ts` -- the helpers
- [x] `src/modules/incident/monitor-draft.integration.test.ts` -- every matrix row
- [x] `src/modules/incident/declare-incident.integration.test.ts`, `deferred-work.md` -- a real monitor, `TEST_ORIGIN`, count 22

**Acceptance Criteria:**
- Given `pnpm run check`, dependency-cruiser reports no `no-cross-module-deps` violation, and `grep -rn "modules/monitoring" src/modules/incident` has no hit.
- Given `dbmate rollback` then `dbmate up` against the owner URL, both succeed.
- Given the full integration suite, `tenant-rls-coverage` passes.

## Implementation Notes

- Sonnet subagents implemented the spec, re-applied it after the loopback, and applied the pass 2 patches. The main session read every diff against the tasks and matrix rows.
- One change outside the task list: `incident-input-validation.integration.test.ts` pins the registered incident event types, so it now lists 8 with `incident/draft_created`.
- `insertImpacts` was pulled out of `insert` so that both inserts share the 23503 mapping.
- **Mutation checks (main session).** Without the lock select, "waits for a confirm in flight" fails. Without `on conflict do nothing`, three tests fail (repeat, next episode while open, dismissed). Both edits were reverted.
- **Loopback.** The pass-1 code is kept in `git stash` ("5.15 pass-1 implementation (before race loopback)"). The auto-mode classifier refused deleting files, so the code was stashed rather than reverted. The stash can be dropped once this story merges.
- **AC.** `pnpm run check` reports no dependency violations, and `grep -rn "modules/monitoring" src/modules/incident` has no hit. The main session ran `dbmate rollback` then `up` with `DBMATE_DATABASE_URL`, and both succeeded.
- Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 253 of 253, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 623 of 623, first run. No failures, so no reruns.
  - e2e: 4 scenarios, 53 steps. `auth:schema:check` is in sync.

## Spec Change Log

- **Review pass 1, intent_gap (B1/E1/V-o1).** A confirm in flight let a next-episode draft open beside an unresolved confirmed incident, because the one-statement insert read a stale `draft`. The owner chose lock first. The frozen `insertDraftIfAbsent` rule and a new matrix row (Confirm in flight) were amended, and the Design Notes corrected. The known-bad state avoided is a draft beside an unresolved confirmed incident from the same monitor. The pass-1 code was stashed, not deleted (`git stash list`: "5.15 pass-1 implementation (before race loopback)"), and its diff is kept at `/tmp/claude-1000/-home-sleipnir-projects-watchdog/053c03c6-f27f-43b8-81f4-373410158ef4/scratchpad/diff-5-15-pass1.patch`. KEEP: everything in that diff, which review found sound apart from the items below. Re-derive from it rather than from scratch. Also apply the review pass 1 patches:
  - `monitor-draft.integration.test.ts`: execute `createDraftFromMonitorCommand` directly and assert `null` for a repeat of an open draft's episode, for the next episode while it is open, and for a dismissed draft's episode (V1). Assert that invalid input (`failureEpisode` 0, 1.5, a non-uuid `monitorId` or `serviceId`) is refused with `ArgumentInvalidException` and writes no row (B4/V2). In the sequential repeat, assert one `draft_created` for that monitor (B10). In the public/status test, assert the own service is not `operational` before disabling (B6). Delete the trailing `recordCheckOutcome(... successOutcome())` in the dismissed test (B11).
  - The event handler wraps the call as `Promise.resolve().then(() => commandBus.execute(...))`, so a synchronous throw still reaches the contextual log (E3).
  - Migration comment: drop "2 in the local database". Under `migrate:down`, note that ids nulled by `up` are not restored (B8/E5).
  - The local database still has `20261017150000` applied from pass 1. If the migration changes, roll it back before re-applying.

## Review Triage Log

Spec review (before approval), Sonnet reviewer, verified by the main session. It verified the single-statement insert by PREPAREing it as `watchdog_app` on Postgres 17, and confirmed that the owner is a superuser and that dependency-cruiser allows `fixtures.ts` to import monitoring.

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | "`monitoring`" in First breach reads as a status | low | Written as `source: monitoring` |
| 2 | Cleanup update depends on a superuser owner | low | Accepted, as in `20261017130000`; noted in the migration comment |
| 3 | `insertDraftIfAbsent` silent on a 23503 from the impact row | low | Maps it to `UnknownAffectedServiceError`, like `insert` |
| 4 | Rows don't say emit vs record; Dismissed needs a really failing monitor | low | Rows that record are named; Dismissed records to `failing` first |
| 5 | Capturing listeners are permanent; negative assertions need scoping | low | Own app; filter to the row's own ids after `drain()` |
| 6 | `updated_at` equality is sound | false | No change |
| 7 | Episode left beside a null monitor after set-null | low | One-line note added |
| 8 | Exception type for the episode check | low | Verified `typebox-guard.ts:65` throws `ArgumentInvalidException`; stated |

Review pass 1. B = blind, E = edge-case, V = verification gap. All three layers ran.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| B1/E1/V-o1 | A confirm (`draft→investigating`) in flight while a next-episode breach inserts lets a draft open beside an unresolved confirmed incident | medium | True. The insert's snapshot still sees `draft`, so `not exists` passes. `on conflict` waits on the draft index for the confirm, finds the row no longer in the partial index, and inserts. The frozen rule says "one statement", so fixing it changes the frozen block. **intent_gap** |
| B2 | A later episode's breach is dropped while an older draft is open, so dismissing it leaves the current episode unacknowledged | false | DOMAIN step 6: a dismissed draft stays dismissed "for the rest of its episode", and a later episode "is eligible for its own draft". 5.16's reconciliation drafting episode 2 is the specified behaviour |
| B3 | No test of the 23503 rollback path | low | Rejected: the breach's `serviceId` comes from the monitor row, whose FK to services holds, and services are never hard-deleted. A test adds setup for an unreachable path |
| B4/V2 | The command's own validation is untested | low | True. patch (direct command calls with invalid input expect `ArgumentInvalidException` and no row) |
| V1 | The `null` result and an error-free repeat are never asserted. Removing `on conflict do nothing` passes every test, because the handler logs and swallows the 23505 | medium | True. patch (execute the command directly for a repeat, the next episode while open, and a dismissed episode, and assert `null`) |
| B5 | `startedAt` is handling time, so 5.16's reuse would stamp the pass time | low | True for 5.16. defer (target Story 5.16) |
| B6 | The public/status test has no positive control | low | True for the status: patch (assert non-`operational` before disabling). `activeIncidents` absence is exact by id |
| B7 | No full index on `(org_id, origin_monitor_id)` for the FK and the lookup | low | Rejected: monitors are never deleted in v1, `incidents_status_idx (org_id, status)` serves the lookup, and a tenant holds tens of incidents |
| B8/E5 | Migration comment names "2 in the local database"; down does not say the nulled ids stay null | low | True. patch (drop the count; note it in down) |
| B9 | sprint-status `in-progress` vs spec `in-review` | false | The present step moves the story to `review` |
| B10 | The sequential repeat checks the row count but not `draft_created` | low | True. patch (assert one `draft_created` for that monitor too) |
| B11 | The dismissed test ends with an unexplained recorded success | low | patch (delete the line) |
| B12 | The `proposeDraft` spec leaves the id and timestamps unchecked | low | Rejected: unlikely regression; additive asserts only |
| E2 | `failureEpisode` above int4 max escapes the guard | low | Rejected: the value comes from `monitors.failure_episode`, an `integer` |
| E3 | A synchronous throw from `commandBus.execute` skips the contextual log | low | True (`command-bus.ts:44` throws synchronously on an unregistered type). patch (`Promise.resolve().then(() => execute(...))`) |
| E4 | A 23503 from the new monitor FK is not mapped | low | Rejected: the monitor id comes from a committed monitor row, and there is no monitor delete in v1 |
| V3 | The orphan clean-up only ever runs against empty tables | low | Rejected as a fix here: the repo has no harness for testing a migration against existing data, and the 5.13 Epic 8 entry tracks building one. Ran by hand on the 2 local rows |
| V-o2 | The concurrent-breach test does not force overlap | low | Rejected: V1's direct `null` assertions prove the guard without needing timing |

Review pass 2, after the loopback. All three layers ran. The main session mutation-checked the result: without the lock select, "waits for a confirm in flight" fails, and without `on conflict do nothing`, three tests fail. Both edits were reverted.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1/B4 | Only `investigating` is tested for the unresolved-confirmed guard. Dropping `identified` and `monitoring` from the list passes | low | True. patch (walk the incident through `identified` and `monitoring`, asserting `runCommand` returns `null` at each). The dismiss-in-flight half is rejected: the sequential "after resolving" case already shows a resolved row lets a draft through |
| E1 | A monitor entering `failing` by edit emits no breach, so it gets no draft | false | By design. Epic 5 context says an edit emits `state_changed`, never `threshold_breached`, and DOMAIN step 6 (story 5.16) reconciles it |
| E2 | `serviceId` may not be the monitor's service | low | Rejected: system callers build it from the monitor row, and incident SQL may not read `monitors` |
| E3/B5 | `monitorName` is not validated, so the title can read `Monitor failure: undefined` | low | True. patch (a non-empty string of at most 183 characters, so the title fits incident's 200; refused with `ArgumentInvalidException`) |
| E4 | `failureEpisode` above int4 max | low | carried E2 (pass 1), rejected |
| E5 | A monitor-FK 23503 is unmapped | low | carried E4 (pass 1), rejected |
| E6/B6 | `insertDraftIfAbsent` accepts a non-draft or origin-less entity | low | Rejected: the only caller passes `proposeDraft`'s entity |
| E7/B12 | The clean-up is a silent no-op under a non-bypass owner | low | carried spec review #2, accepted |
| B1 | The B5 deferral is not in deferred-work.md | false | Written by this step (defer), below |
| B2 | The schema test does not pin `SET NULL (origin_monitor_id)` or the referenced columns | low | True (`confdeltype` is `n` for a plain set-null as well). patch (match both in `pg_get_constraintdef`) |
| B3 | The 300 ms wait passes without the lock, because the draft index also waits | low | True: the mutation failed on the row count, not the wait. patch (a neutral message, and a comment that `null` and one row are the proof) |
| B7 | The insert column list is written twice | low | Rejected: a refactor, not a correction. Both lists are next to each other in one file |
| B8 | A `declare-incident` comment says drafts "arrive in Epic 5" | low | patch (reword) |
| B9 | The error log leaves out the episode; a `null` outcome logs nothing | low | patch (add `failureEpisode` to the context). Logging `null` is rejected: it adds a branch for an expected outcome |
| B10 | The dismissed test asserts status on the shared service | low | True: later tests leave failing monitors on it. patch (its own service) |
| B11 | The port doc does not mention the row locks | low | patch (one sentence) |

## Design Notes

- The lock is what makes the confirmed-incident check hold. Without it, the insert's snapshot can still see `draft` while a confirm commits, and once the row leaves the draft index nothing else stops the insert (review pass 1, B1). With no open incident there is nothing to lock, and the two indexes guard races between breaches.
- AC "dismissing emits `incident.dismissed` only" is read against DOMAIN's catalog. `incident.state_changed` fires on every legal transition, so "only" means never `resolved` (or `confirmed`). The transition handler already behaves this way.
- `startedAt` is now, because the event carries no check time. The breach is handled within milliseconds of the check, so the two differ by little.

## Verification

**Commands** (only postgres and mailpit running):
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside (never while another suite runs) -- pass
- `timeout 900 pnpm run test:integration` -- pass. Rerun any failure 2-3 times and report every one.
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
