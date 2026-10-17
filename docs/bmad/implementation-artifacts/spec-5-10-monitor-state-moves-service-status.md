---
title: 'Story 5.10: Monitor state moves service status'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '2539917ea126b57530874168580ad0783389ec63'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Status recomputation passes `monitorState: null`, so a failing monitor never moves a service's status. FR5's fourth input, which Story 2.18 could not construct, is still unproven.

**Approach:** The `service` module's recomputation reads the organization's `monitors` rows and derives each service's `monitorState` with DOMAIN's M1 rule. It also subscribes to `monitor.state_changed`. The worker's reconciliation already calls the same recomputation, so it picks the input up without a change.

## Boundaries & Constraints

**Always:**
- The contract is story 5.10's acceptance criteria in epics.md. The rules are DOMAIN "How monitor state is derived" (M1, L997), "Status-resolution precedence function" and "Status recomputation" (M3, L1068).
- **Shared rule.** `src/shared/domain/monitor-state.ts` gains a pure `serviceMonitorStateOf(monitors: MonitorStateInput[])`. It returns the worst `monitorStateOf` among the monitors, ranked `failing` > `degraded` > `healthy`, or null when none contribute. `resolveServiceStatus` and `statusFromMonitorState` stay as they are.
- **Read.** `lockLiveServiceInputs` keeps its lock-first order. After the lock, one more read selects `service_id, enabled, last_checked_at, consecutive_failures, failure_threshold` from `monitors`, with RLS doing the scoping. Each `LiveServiceStatusInputs` gains `monitors: MonitorStateInput[]`. The handler passes `serviceMonitorStateOf(service.monitors)` and the placeholder comment goes.
- **Trigger.** `monitorStateChangedEvent` joins `RECOMPUTE_TRIGGERS`. `monitor.check_succeeded` and `monitor.check_failed` do not.
- **Allowlist.** `foreign-table-allowlist.spec.ts` adds `monitors` to `service`'s foreign tables, with a comment naming Story 5.10.
- Tests import from `src/shared/events/` and `src/shared/testing/`, never from `src/modules/monitoring/` (`no-cross-module-deps` covers test files). Any helper a suite needs goes in `src/shared/testing/`.
- The stale comment at `serve-service-status.integration.test.ts:162-163` is replaced by the case it promised.

**Never:**
- Change the monitoring module, its events, or the lock order.
- Read monitor state from an event payload.
- Write a migration. `monitors_service_id_idx` already exists.
- Run an unscoped worker pass in a test.

## I/O & Edge-Case Matrix

Integration rows put monitor counters in place with `setMonitorCheckState` (it emits nothing), then emit an event or run the real emitter, and wait with `app.eventBus.drain()`. An emitted event carries the created monitor's real ids and a complete payload; the handler reads only `orgId`. Threshold 3 unless stated.

| Scenario | Input / State | Expected |
|---|---|---|
| Trigger | One monitor at 3 failures; emit `monitor.state_changed` | Service is `major_outage`; one `service.status_changed` |
| Checks trigger nothing | Same counters; emit only `check_failed` and `check_succeeded` | Service stays `operational`; nothing announced |
| Ladder, REST = GraphQL | Three services, one monitor each, at 3, 1 and 0 failures | Listed as `major_outage`, `degraded`, `operational` on both surfaces |
| Worst of monitors | One service: a failing monitor and a healthy one | `major_outage` |
| Disabled contributes nothing | A monitor created with `enabled: false`, at 3 failures | `operational` |
| Never checked contributes nothing | A monitor at 3 failures with `lastCheckedAt: null` | `operational` |
| Override wins | Failing monitor plus override `degraded` | `degraded` |
| Worst-of | Failing monitor plus `minor` incident gives `major_outage`. Healthy monitor plus `minor` incident gives `degraded` | as stated |
| Disable | Failing monitor that has already moved the service; REST `PATCH enabled: false` | Back to `operational`, through update-monitor's own `state_changed` |
| Lost event | Failing counters, no event; run `recomputeServiceStatusCommand({ orgId })` | Corrected to `major_outage`, and returned as a change |
| Archived | Archived service with a failing monitor; recompute | Skipped, so `last_known_status` is unchanged |
| Restored | That service, restored through REST | `major_outage`, through `service.restored` |
| Tenant scope | Org B's service has a failing monitor; recompute org A | Org A's services keep their status; nothing announced for org A |
| Real check | In-process `runMonitorPass(app, quietLogger, { orgIds: [own] })`. The monitor has `failureThreshold` 1 and targets `/error` | After drain, the service's `last_known_status`, read with SQL as the file already does, is `major_outage` |

Unit (`monitor-state.spec.ts`): an empty list and all-null inputs give null. A failing monitor beats a degraded one, which beats a healthy one, in any order. A disabled or never-checked failing monitor is ignored.

</frozen-after-approval>

## Code Map

- `src/shared/domain/monitor-state.ts` (+ `.spec.ts`) -- `monitorStateOf` and `MonitorStateInput`, to reuse. Add `serviceMonitorStateOf` beside them.
- `src/shared/domain/status-inputs.ts` -- `MonitorDerivedState`, `worstServiceStatus`, `SERVICE_STATUS_RANK`. They are ranked by service status, so the monitor rank is a separate small order.
- `src/modules/service/database/service-status.repository.ts` -- the lock query, then incidents, then maintenance, then grouping in JS. Add the monitors read after maintenance in the same way.
- `src/modules/service/commands/recompute-service-status/recompute-service-status.event-handler.ts`
  - `RECOMPUTE_TRIGGERS` (:37) gets the monitor event.
  - `monitorState: null` (~:100) is replaced.
  - The JSDoc above the triggers names the monitor event and M3.
- `src/shared/events/monitor.events.ts` -- `monitorStateChangedEvent`. Its payload is `{ orgId, monitorId, serviceId, monitorName, from, to, failureEpisode }`. `monitorCheckFailedEvent` and `monitorCheckSucceededEvent` are its siblings.
- `src/shared/db/foreign-table-allowlist.spec.ts` -- the `FOREIGN.service` list.
- `src/modules/service/recompute-service-status.integration.test.ts`
  - Setup: `signUpWithOrg`, `announced` (from `serviceStatusChangedEvent`), `settle = app.eventBus.drain()`, `silentIncident`, `stored(orgId, id)`.
  - Add a `describe('Story 5.10 …')` with every matrix row except Ladder and Real check. The suite already has orgs A and B for the Tenant row.
- `src/modules/service/serve-service-status.integration.test.ts` -- the ladder row over REST and GraphQL, at :162.
- `src/shared/testing/fixtures.ts` -- `createMonitor(app, cookie, serviceId, overrides)`, `setMonitorCheckState`, `archiveService`, `declareIncident`.
- `src/worker-lifecycle.integration.test.ts` -- the in-process section (`make(org, path)`, `newOrg`, `quietLogger`, the `/error` endpoint, allowed CIDRs already set). Add the Real-check row there. This file is outside `src/modules`, so it may run the worker pass. Its `app` comes from `buildApp`, which `startWorker` also uses (`src/worker.ts:304`), so the row proves that a real check moves status in the app the worker builds. No incident handler for `threshold_breached` exists yet (5.15), so the breach has no side effect.
- Do not touch `src/worker.ts`. Reconciliation already runs `recomputeServiceStatusCommand` per organization (~:95).

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/domain/monitor-state.ts`, `monitor-state.spec.ts` -- `serviceMonitorStateOf` and its unit cases
- [x] `src/modules/service/database/service-status.repository.ts` -- the monitors read and the `monitors` field
- [x] `recompute-service-status.event-handler.ts` -- the trigger, the derived input and the JSDoc
- [x] `src/shared/db/foreign-table-allowlist.spec.ts` -- `service` → `monitors`
- [x] `src/modules/service/recompute-service-status.integration.test.ts` -- the recompute rows
- [x] `src/modules/service/serve-service-status.integration.test.ts` -- the ladder row on both surfaces
- [x] `src/worker-lifecycle.integration.test.ts` -- the real-check row

**Acceptance Criteria:**
- Given story 5.10's criteria, when the unit and integration suites run, then each criterion is proven by a matrix row, and `pnpm run check` passes with the allowlist entry.

## Implementation Notes

- A Sonnet subagent implemented the spec, and the main session read the whole diff against every task and matrix row. Its first full integration run had 11 failures, all in the new `describe`. It had been declared beside the 2.17 suite rather than inside it, so it ran after `app` closed. Once nested, nothing failed.
- The Ladder row recomputes through `recomputer.recompute(orgAId)` rather than an event, because what it proves is the listing on both surfaces.
- The Tenant row holds by construction. Service ids are globally unique, so another organization's monitors could never match org A's services. The guard that matters is RLS on `monitors`, which `tenant-rls-coverage` already pins.
- Verification by the main session, 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 249 of 249, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 567 of 567 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.
  - No child worker was left running.

- Review pass 1: four patch findings (B2, B3, B4, B6) went back to the same implementation subagent, and the main session read the delta. Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 249 of 249, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 568 of 568 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps.
  - `auth:schema:check` is in sync.
  - No child worker was left running.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap (V reported no gaps).

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| B2 | Three comments still describe the pre-5.10 inputs | low | `service-status.repository.ts` JSDoc names only incidents and maintenance. `effective-status.ts:29-33` says null means "no monitor". The `status-inputs.ts` header says `monitoring` "will" produce the state. patch |
| B3 | The repository's "No lock" comment gives the wrong reason | low | `for key share` never conflicts with `for no key update`. The read is correct because `state_changed` is emitted after commit and the read runs after the lock in a fresh READ COMMITTED statement (Design Notes). patch |
| B4 | No test moves a service back from an outage through monitor state, other than disabling | low | The edit path (DOMAIN L294, a `failureThreshold` change) emits `state_changed` and is untested here. patch (PATCH the threshold, expect `degraded`) |
| B6 | The disable and restore rows assert the status but not the announcement | low | Only the trigger row checks `announcedFor`. A write without an announcement would pass. patch |
| B1/E1 | The Tenant row cannot fail | low | Service ids are globally unique, so the `service_id` grouping drops foreign rows even without RLS. Leakage cannot happen by construction, and RLS on `monitors` is pinned by `tenant-rls-coverage`. The row is in the frozen matrix. rejected |
| B5 | "Lost event" calls the command, not the reconciliation | false | The command is the reconciliation. `due-maintenance.integration.test.ts:284` proves the pass runs it, and this row proves it reads monitors |
| E2 | Reconciliation can log a false "drifted" between a check's commit and its handler | low | Accepted in Design Notes ("False drift log"); the incident path has the same window. rejected |
| B7 | sprint-status says in-progress while the spec says in-review; 5-9 flipped here | false | Step 5 sets `review` when presenting. 5-9 → done was the owner's instruction for this branch |
| B8 | The monitors read selects every monitor in the org and filters per service | low | Same shape as the `impacts` read. Tens of services, so no measurable cost. rejected |
| B9 | The worker-lifecycle row destructures `[row]` without a length assertion | low | A missing row still fails the test, with a TypeError. rejected |
| B10 | Test tuples type statuses as `string`, overrides as `object` | low | A misspelled status fails the assertion at runtime. Cosmetic. rejected |
| B11 | `serviceMonitorStateOf` could take a readonly array | low | Cosmetic. rejected |

## Design Notes

**Concurrency.** A check, or an edit, emits `state_changed` only after its transaction commits. So the recomputation that the event triggers reads the committed counters. It reads them in a READ COMMITTED statement that runs after the services lock, and the lock only queues recomputations behind each other. The monitors read takes no lock. A check's update leaves the monitor's foreign-key columns alone, so Postgres skips the foreign-key check and the update takes no lock on `services`. Neither side waits on the other, so they cannot deadlock.

**Archived services.** Their monitors are read but match no locked live service, so they are ignored. The public page reads `last_known_status`, so it follows without a change.

**False drift log.** The maintenance pass's reconciliation can run between a check's commit and its in-process handler. It then corrects the status and logs "drifted". The incident path has the same window today, and the next event-driven recompute finds nothing to change. Accepted.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass, with only postgres and mailpit up. Rerun any failure 2–3 times and report all of them.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- pass
