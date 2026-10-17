---
title: 'Story 5.16: Reconcile missed drafts each pass'
type: 'feature'
created: '2026-10-17'
status: 'done'
baseline_commit: '42f053bbaae6f11ed2bcf2285400736e598d15e8'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A draft is opened only by the `monitor.threshold_breached` handler. Events are one-shot, so a handler that failed leaves a breach with no draft, and an edit that moves a monitor into `failing` emits no breach at all (DOMAIN M2 step 6; Monitor, "Editing a monitor can move its derived state").

**Approach:** A new `monitoring` query, `listMonitorsAtThresholdQuery`, lists each organization's enabled, at-threshold monitors on unarchived services. `runWorkerPass` runs it per organization and executes story 5.15's `createDraftFromMonitorCommand` for each, through the buses. The command already applies every incident-side condition and returns `null` when a draft or incident exists, so a repeat is a silent no-op.

## Boundaries & Constraints

**Always:**
- The contract is story 5.16's acceptance criteria in epics.md. The rule is DOMAIN, Consecutive-failure to draft-incident rule, step 6.
- **Query** `src/modules/monitoring/queries/list-monitors-at-threshold/list-monitors-at-threshold.handler.ts`: `listMonitorsAtThresholdQuery = monitoringActionCreator<{ orgId: string }>('list_at_threshold')`, result `Promise<MonitorEntity[]>`. Handler only, no route, resolver or schema: the actor is the worker. Shape as `list-monitors.handler.ts`.
- **Repository** `monitorRepository.listAtThreshold(tx)`: `select m.* from monitors m join services s on s.id = m.service_id and s.org_id = m.org_id where m.enabled and s.archived_at is null and m.consecutive_failures >= m.failure_threshold order by m.id`. It reads only `monitors` and `services`; `services` is already in the allowlist's `FOREIGN.monitoring`, whose comment gains "and the at-threshold query (Story 5.16)".
- **Worker** `runWorkerPass`: a new step per organization, in its own `try`, after status reconciliation and before the rollup refresh, so a failed reconciliation does not skip it. It runs the query through `app.queryBus.execute`, then for each monitor `app.commandBus.execute(createDraftFromMonitorCommand({ orgId, monitorId: m.id, serviceId: m.serviceId, monitorName: m.name, failureEpisode: m.failureEpisode }))`, one at a time.
  - Each monitor's command has its own `try`: a failure logs `{ orgId, monitorId, failureEpisode, err }` at `error` with "reconciling a monitor draft failed", marks the organization failed, and the next monitor still runs. A failed query logs `{ orgId, err }` with "draft reconciliation failed for organization".
  - When any command returned an id, log at `warn` `{ orgId, opened: [monitorId, …] }` with "opened monitor drafts no breach event had opened". Nothing is logged when nothing opened.
- `check-result-partitions.integration.test.ts` has two stub apps with only a `commandBus`: the one in "runs maintenance once, last, …" (l.~438, an unscoped pass, so without a `queryBus` every organization fails and the pass rejects) and `failingStub` (l.~481). Both gain a `queryBus` whose `execute` returns `[]` for `monitor/list_at_threshold` and throws on any other type, so their error counts stay exact.
- Test helpers go in `src/shared/testing/fixtures.ts` (Constraint 9).
- **Imports (owner, 2026-10-17).** "Imports neither module" means the worker reaches both only through the buses, never a repository or SQL. It imports `listMonitorsAtThresholdQuery` and `createDraftFromMonitorCommand` (and their result types) from the handler files, as it does for its other steps.
- **`startedAt` (owner, 2026-10-17).** A reconciled draft keeps the command's "now". The deferred-work entry targeting Story 5.16 is closed; an operator corrects `startedAt` when confirming.
- **Spec size (owner, 2026-10-17).** Kept as one story above 1600 tokens: every matrix row tests the one pass step this story adds.

**Never:**
- Read `incidents` from `monitoring`, or import `src/modules/incident` from `src/modules/monitoring` (the test reads incidents with SQL through `withTenantTransaction`, as `recompute-service-status.integration.test.ts` does).
- Change `createDraftFromMonitorCommand`, the event handler, or any migration. No new migration.
- Run an unscoped pass in tests; every pass passes `{ orgIds }` for the file's own organizations.
- Edit `docs/genesis`.

## I/O & Edge-Case Matrix

Tests go in the new `src/modules/monitoring/draft-reconciliation.integration.test.ts`: its own app, two organizations of its own, public services, monitors from `createMonitor`. "At threshold, no event" means `setMonitorCheckState` (direct SQL, no events) with `consecutiveFailures` at the threshold and `failureEpisode` ≥ 1, since a new monitor is at episode 0 and the command refuses 0. "Dismiss" is `transitionIncident(…, 'resolved')` from `draft`; "confirm" is `'investigating'`, and resolving is then `'resolved'`. A "stub" app is `{ commandBus, queryBus }` whose `execute` throws for the row's target and delegates every other action to the real app's bus; `runWorkerPass` touches nothing else, and `drain()` is called on the real app. "Pass" means `runWorkerPass(app, logger, { orgIds })` then `drain()`. Incident assertions filter by `origin_monitor_id`.

| Scenario | Input / State | Expected |
|---|---|---|
| Query shape | Monitors: at threshold; below; disabled at threshold; at threshold on an archived service; one of each in the second org | The query for org A returns only the first, with its `failureEpisode`, ordered by id |
| Lost event | At threshold at episode 2, no event | One pass: one draft, `source: monitoring`, `origin_failure_episode` 2, one `incident/draft_created`. A second pass: still one incident, no further event |
| Edit opened it | Threshold 3, `setMonitorCheckState` to 2 failures at episode 0; PATCH `failureThreshold` 2 | The edit emits `monitor/state_changed` and no `threshold_breached`. `failure_episode` is now 1. Next pass: one draft for episode 1 |
| Dismissed | Lost-event draft, dismissed through the API | Three passes: no new incident. A failure recorded with `recordCheckOutcome` (after `createCheckResultPartitions`) still raises `consecutive_failures` |
| Confirmed then resolved | Draft confirmed then resolved through the API, monitor still at threshold | Two passes: no new incident for that episode |
| Not eligible | Below threshold; disabled; archived service | A pass creates no incident for any |
| Next episode | After the Dismissed row, `setMonitorCheckState` to 0 failures, then to the threshold at episode + 1, no event | A pass opens one draft for the new episode |
| One org fails | Two orgs at threshold. A stub `queryBus` throws for org A, delegating org B to the real bus | Org A's failure is logged with its `orgId`; org B gets its draft; the pass resolves |
| One monitor fails | Two monitors at threshold in one org; a stub `commandBus` throws `createDraftFromMonitorCommand` for the first, delegating the rest | One error with that `monitorId`; the second still gets its draft |

</frozen-after-approval>

## Code Map

- `src/worker.ts:49-165` -- `runWorkerPass`. Per-org loop with `orgFailed`; reconciliation `try` (l.~85-115), rollup `try` (l.~117-135). New step goes between them. Imports action creators from handler files (l.3-21).
- `src/modules/monitoring/queries/list-monitors/list-monitors.handler.ts` -- query shape to copy (`init()` registers on `queryBus`; DI loads `*.handler.ts` automatically).
- `src/modules/monitoring/index.ts` -- `monitoringActionCreator` (prefix `monitor`), `Dependencies`.
- `src/modules/monitoring/database/monitor.repository.ts:70-85` -- `listDue`, the join to copy. No port file.
- `src/modules/incident/commands/create-draft-from-monitor/create-draft-from-monitor.handler.ts:8-23` -- payload and `string | null` result; type `incident/draft.create_from_monitor`.
- `src/modules/monitoring/domain/monitor.domain.ts:~169-175`, `src/shared/domain/monitor-state.ts:39` -- an edit into `failing` bumps `failure_episode`; `update-monitor.handler.ts` emits only `state_changed`.
- `src/shared/db/foreign-table-allowlist.spec.ts` -- `FOREIGN.monitoring: ['services']` already; comment only. Test files are not scanned.
- `src/modules/monitoring/check-result-partitions.integration.test.ts:~481-515` -- `failingStub` and `logger()`; the stub has only `commandBus` and throws on unknown types.
- `src/modules/maintenance/due-maintenance.integration.test.ts`, `uptime-rollups.integration.test.ts` -- scoped `runWorkerPass` with `buildApp({ logger: false })`.
- `src/shared/testing/fixtures.ts` -- `createService`, `createMonitor`, `archiveService`, `setMonitorCheckState`, `createCheckResultPartitions`, `recordCheckOutcome`, `failureOutcome`, `successOutcome`, `transitionIncident`. `src/shared/testing/events.ts` -- `capturingTypes`. `src/shared/testing/tenant.ts` -- organizations.
- `src/modules/service/recompute-service-status.integration.test.ts` -- precedent for a module's test reading `incidents` with SQL.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/monitoring/database/monitor.repository.ts` -- `listAtThreshold`
- [x] `src/modules/monitoring/queries/list-monitors-at-threshold/list-monitors-at-threshold.handler.ts` -- the query
- [x] `src/worker.ts` -- the reconciliation step and its doc comment line
- [x] `src/shared/db/foreign-table-allowlist.spec.ts` -- comment
- [x] `src/modules/monitoring/check-result-partitions.integration.test.ts` -- `queryBus` stub
- [x] `src/shared/testing/fixtures.ts` -- any helper the matrix needs that is missing
- [x] `src/modules/monitoring/draft-reconciliation.integration.test.ts` -- every matrix row
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- remove the `startedAt` entry targeting Story 5.16

**Acceptance Criteria:**
- Given `pnpm run check`, dependency-cruiser reports no violation and `grep -rn "incidents" src/modules/monitoring --include='*.ts' | grep -v test` has no SQL hit.
- Given the full integration suite, no existing file changes except the two stubs in `check-result-partitions.integration.test.ts`.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against the tasks and matrix rows.
- One helper added to `fixtures.ts`: `updateMonitor` (PATCH).
- The new test cannot import the incident handler file (dependency-cruiser), so its stub matches the type string `incident/draft.create_from_monitor`.
- "One monitor fails" visits one organization, which the failure marks failed, so that pass rejects with "every organization failed (1)". The test asserts the rejection.
- The main session tightened the Lost event row to count `draft_created` for its own monitor (exactly 1, then 0), rather than "at least one" in the organization.
- **Mutation checks (main session).** With the threshold filter changed to `>= 0`, the query and ineligible tests fail. With the per-monitor `catch` rethrowing, "keeps going when one monitor fails" fails. Both edits were reverted.
- The deferred-work "From Story 5.15" section is removed; its one entry was the `startedAt` entry this story closes.
- Review pass 1 patches applied by the same subagent; the main session read them. Two entries deferred (AGENTS.md pitfall; ARCHITECTURE wiring, owner).
- Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings), no dependency violations.
  - Unit tests: 253 of 253, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 633 of 633, first run. No failures, so no reruns.
  - e2e: 4 scenarios, 53 steps. `auth:schema:check` is in sync.

## Spec Change Log

## Review Triage Log

Spec review (before approval), Sonnet reviewer, verified by the main session.

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | A second stub app (l.~438) runs an unscoped pass with no `queryBus`, so every organization fails and the pass rejects | high | Confirmed at l.438-459. Both stubs named |
| 2 | Deleting the `startedAt` entry drops its `breachedAt` suggestion | low | Owner decision; recorded in Constraints and Design Notes |
| 3 | At-threshold setup must set episode ≥ 1, or the command refuses it | medium | Stated in the matrix preamble |
| 4 | "Edit opened it" needs episode 0 at 2 failures; dismiss and confirm need naming | medium | Rows and preamble say how |
| 5 | Stub rows under-specified: delegate every other action, drain the real app | low | Stated in the preamble |
| 6 | Query and command are separate transactions, so a just-recovered monitor can get a draft for its ended episode | low | Accepted; Design Notes |
| 7 | Event handler versus pass race | false | 5.15's lock and `on conflict do nothing`; the loser returns `null` |
| 8 | Other real-app `runWorkerPass` suites gain drafts | false | Neither sets failures; the query returns `[]` there |

Review pass 1. B = blind, E = edge-case, V = verification gap. All three layers ran at the session's model.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| B1/E3 | One monitor's persistent command failure marks the organization failed, so a single-tenant pass rejects every time | low | Rejected. The frozen block chooses it, and a failed rollup already does the same. No persistent cause is reachable: names are capped at 120 (`monitors_name_ck`), under the command's 183; episode 0 at threshold is unreachable (E1) |
| B2 | The doc comment's "no work means every one failed" is stale | false | Unchanged meaning: an organization fails when any step fails, as with rollups since 5.11 |
| B3/V4 | The "opened" warn and its silence are never asserted | low | patch |
| B4/V2 | Nothing is strictly above the threshold, so `=` passes; the id-order check sees one row | low | patch (a monitor at 5 of 3, two listed rows in order) |
| B5 | Open draft and confirmed-unresolved guards across episodes untested at the pass level | low | Rejected. The pass adds no logic there; 5.15's "Next episode while the draft is open" and "Confirmed and unresolved" rows test the command |
| B6/V1 | A failed status reconciliation not skipping drafts, and a failed draft step not skipping rollups, are untested | low | patch |
| B7 | The warn can name a draft whose event handler was still in flight | low | Rejected. Its message is literally true: no event had opened it, and the handler then gets `null` |
| B8a | The `options` comment says a pass reconciles only services | low | patch |
| B8b | AGENTS.md's unscoped-pass pitfall does not say a pass now opens drafts | low | defer (AGENTS.md edit) |
| B9 | ARCHITECTURE.md:494 "Every pass also reconciles" names only status | low | defer (Genesis edit, owner) |
| B10 | Spec `in-review` vs sprint `in-progress` | false | The present step moves the story to `review` |
| B11 | Dismissed never passes again once further over threshold | low | patch |
| V3 | The worker's title and service mapping is never asserted | low | patch |
| V-o1 | `assert.rejects` without a matcher | low | patch |
| E1 | At threshold with `last_checked_at` null or episode 0 fails every pass | low | Rejected. Re-enabling resets failures to 0 with the timestamp, and entering `failing` increments the episode, so neither is reachable outside direct SQL |
| E2 | A monitor disabled, archived or recovered between query and command still gets a draft | low | Rejected. Design Notes accept it: the episode did breach, and nothing duplicates |
| E4 | Org B lacks the ineligible monitors the Query shape row names | low | patch |

## Design Notes

- Per-monitor `try`: one monitor's failure (say a transient 40001) must not leave the organization's other breaches unproposed until the next pass.
- The step sits in the maintenance pass, not the monitor pass, because DOMAIN reconciles drafts "as it reconciles status", and the monitor pass never reconciles.
- A reconciled draft's `startedAt` is the pass time. For an edit-opened episode no check breached at all, and `monitors` records no moment of entering `failing`.
- The query and each command run in separate transactions, so a monitor that recovers in between, with its breach draft lost, gets a draft for the episode that just ended. Accepted: that episode did breach, nothing duplicates (5.15's lock and indexes), and the next pass sees it healthy.
- Sequential commands: a tenant has a handful of at-threshold monitors, and the command takes row locks on incidents.

## Verification

**Commands** (only postgres and mailpit running):
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside (never while another suite runs) -- pass
- `timeout 900 pnpm run test:integration` -- pass. Rerun any failure 2-3 times and report every one.
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
