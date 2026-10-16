---
title: 'Story 5.6: Record a check result and count consecutive failures'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '2d1581c44d80c93d457be0cc7449344bf2e55133'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The check adapters (5.4, 5.5) return a `CheckOutcome` and write nothing. Nothing stores it, counts failures, or tells the rest of the system that a monitor's state moved. Without that, there is no history, no status input, and no draft trigger.

**Approach:** A system command, `RecordCheckResultCommand`, takes `{ orgId, monitorId, outcome }`. In one tenant transaction it stores the result and updates the monitor's counters. After commit it emits DOMAIN's monitor events (M2 steps 3–4). There is no route, resolver or worker wiring; tests call it through `app.commandBus.execute`.

## Boundaries & Constraints

**Always:**
- Story 5.6's six acceptance criteria (epics.md) are the contract. The rules come from DOMAIN M1 ("How monitor state is derived"), M2 steps 3–4 ("Consecutive-failure to draft-incident rule"), M8 (append-only) and Monitor `failure_episode`.
- The handler calls `assertUuid(monitorId, 'monitorId')` before any SQL. A monitor it cannot see (unknown, or in another organization) raises `NotFoundException`. Nothing is stored and nothing is emitted.
- `outcome` is trusted, typed input from the adapters. `assertUuid` is its only guard. This matches the other commands that have no route (`maintain-check-result-partitions`, `transition-due-maintenance`), which use no request schema. A `checkedAt` outside the existing partitions makes the insert fail. The transaction rolls back and nothing is emitted. Adapters stamp `checkedAt` with the current time, so this is accepted.
- `last_checked_at` takes the recorded result's `checkedAt`, as the AC says: the last write wins, even when an older result commits second. Going backwards only makes the monitor due sooner. Decided 2026-10-16 (review F1).
- The transaction runs in this order:
  1. Lock the monitor with `monitorRepository.getForUpdate` (`for no key update`).
  2. Append the `check_results` row. `service_id` comes from the locked monitor row, never from the caller (5.3 triage E5). `error_message` passes through `truncateMessage`. `metadata` is stored as given, so an SSL result keeps 5.5's `certificateFingerprint` / `certificateExpiresAt` / `daysRemaining` exactly, nulls included.
  3. If the monitor is enabled, write `consecutive_failures` (0 on success, +1 on failure), `last_checked_at = outcome.checkedAt`, and `failure_episode` (+1 only when the derived state enters `failing`). `updated_at` is not touched, because it marks configuration edits.
- Lock first, then append. The AC lists append then lock. Both happen in one transaction, so the order cannot be observed, and locking first is what lets `service_id` be read from the row.
- Before and after states come from `monitorStateOf`. "After" uses the new counters and the new `lastCheckedAt`. The rule "entering `failing` increments the episode" is extracted into `src/shared/domain/monitor-state.ts` as a pure function. Both this command and `applyUpdate` call it, so edits and checks cannot disagree.
- A disabled monitor:
  - Its row is stored and its check event is emitted.
  - Its counters, `last_checked_at` and `failure_episode` are left unchanged.
  - No state event is emitted.
- After commit, events are emitted in this order:
  1. `check_succeeded` or `check_failed`.
  2. `state_changed` (`from`, `to`, `failureEpisode`), only if the state moved.
  3. `threshold_breached`, only when the state entered `failing`. It carries the new `failureEpisode`.
  4. `recovered`, only for a move from `failing` to `healthy`. It carries the episode that ended.
  Never-checked → `healthy` is a move, so it emits `state_changed`.
- Every payload is `MonitorEventPayload` (`orgId`, `monitorId`, `serviceId`, `monitorName`). Extra fields, by event:
  - `check_succeeded`: `checkedAt` (ISO string).
  - `check_failed`: `checkedAt` (ISO string) and `errorCode`.
  - `threshold_breached`: `failureEpisode`, the new episode.
  - `recovered`: `failureEpisode`, the unchanged value, which is the episode that ended.
  Names are `monitor/<catalog name>`, as 5.1 established. The test asserts that the types observed are exactly `monitor/check_succeeded`, `check_failed`, `state_changed`, `threshold_breached` and `recovered`, each a DOMAIN catalog name.
- Tests:
  - use `src/shared/testing` (`signUpWithOrg`, `createService`, `createMonitor`, `createCheckResultPartitions`, event capture);
  - run no worker pass;
  - never order rows by time (AGENTS clock skew). Compare counts and sets, and read event order from emit order;
  - build each `checkedAt` as `base + i` ms, where `base = new Date()` taken in the test, never earlier than now. Call `createCheckResultPartitions()` in `before`, and never run partition maintenance.

**Never:**
- a migration;
- a route, resolver or `.schema.ts` (it is a system command);
- worker wiring (5.8, 5.9);
- the SSL warning or `monitor_ssl_warnings` (5.7);
- a service status recompute (5.10);
- a write to `incidents` (5.15);
- an `UPDATE` or `DELETE` on `check_results`;
- importing `dtos/` from the handler;
- reading `process.env`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Episode walk | threshold 3, never checked; F, F, F, S, F, F, F, F | `state_changed` none→degraded, degraded→failing, failing→healthy, healthy→degraded, degraded→failing; `threshold_breached` at 3rd F (episode 1) and 7th F (episode 2) only; `recovered` once; 8th F emits no state event and leaves episode 2 | N/A |
| First success | threshold 3, never checked; S | `state_changed` null→healthy; no `recovered`; episode unchanged | N/A |
| Threshold 1 | threshold 1, never checked; F | `state_changed` null→failing, `threshold_breached` episode 1; `degraded` never appears | N/A |
| Unchanged state | healthy; success | row stored, `check_succeeded`, no `state_changed` | N/A |
| Row content | SSL failure outcome, metadata with fingerprint; message over 512 chars | row has the monitor's `service_id`, status, latency, code, message truncated to 512, metadata equal to the input | N/A |
| Concurrent | degraded at 1 of threshold 2. A test transaction holds `for no key update` on the row and writes nothing, while two failures are fired through `app.commandBus.execute` | neither settles in 300 ms before release. Then `consecutive_failures` is 3, 2 `check_results` rows exist for the monitor, `failure_episode` is +1, and there is exactly one `threshold_breached` and one degraded→failing | holder released in `finally` |
| Disabled | disabled monitor with counters 2, episode 1, `last_checked_at` T; failure | row stored, `check_failed`; counters, T and episode unchanged; no state events | N/A |
| Unknown / other org | random uuid; another org's monitor id | no row, no event | `NotFoundException` |
| Bad id | `monitorId: 'nope'` | no SQL | 400 from `assertUuid` |

</frozen-after-approval>

## Code Map

- `src/shared/events/monitor.events.ts` -- add `monitorCheckSucceededEvent`, `monitorCheckFailedEvent`, `monitorThresholdBreachedEvent`, `monitorRecoveredEvent` beside `monitorStateChangedEvent`, with their own payload types.
- `src/shared/domain/monitor-state.ts` (+ `.spec.ts`) -- `monitorStateOf` is unchanged. Add the pure function `failureEpisodeAfter(before, after, episode)`.
- `src/modules/monitoring/domain/monitor.domain.ts` `applyUpdate` -- its inline episode rule (`after === 'failing' && before !== 'failing'`) switches to the shared function. Add `applyCheck(current, status, checkedAt) → { monitor, before, after }`, which applies the disabled rule.
- `src/modules/monitoring/database/monitor.repository.ts:69` -- reuse `getForUpdate`. Add `recordCheck(tx, id, { consecutiveFailures, failureEpisode, lastCheckedAt })`, which writes only those three columns.
- `src/modules/monitoring/database/check-result.repository.ts` -- new. `append(tx, row)` inserts with `tx.sql.json(metadata)` and returns the id. It follows `monitor.repository.ts`'s factory and `TenantTransaction` shape. Register it in `src/modules/monitoring/index.ts` `Dependencies`.
- `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts` -- new. Its shape follows `maintain-check-result-partitions.handler.ts` (no route) and `update-monitor.handler.ts` (lock, then emit after commit).
- `src/modules/monitoring/checks/check-outcome.ts` -- `CheckOutcome<M>` and `truncateMessage` are reused unchanged.
- `db/migrations/20261009130000_create_check_results.sql` -- columns and FKs. `watchdog_app` has insert only. Read it; do not edit it.
- `src/modules/monitoring/monitor.integration.test.ts` -- its `deepEqual` over the registered monitor event types must list the four new types. Lines 552–600 are the lock-gate concurrency pattern to copy.
- `src/modules/monitoring/monitor-input-validation.integration.test.ts` -- subscribes to every creator in `monitor.events` and asserts that none fired. The new creators need no change there.
- Locks. The order is: monitor row (`for no key update`), then the insert's FK key-share on `monitors`, `services` and `organization`, then the update of `monitors`. That is `update-monitor`'s lock-first order. The `service` module never touches `monitors`. Partition DDL takes its locks with `nowait` and retries. So there is no deadlock path, as long as the transaction takes no other lock after the monitor's.
- `src/shared/testing/fixtures.ts` `setMonitorCheckState` stays for tests that need arbitrary counters. Its "until 5.6" comment is updated.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/events/monitor.events.ts` -- the four creators and their payload types
- [x] `src/shared/domain/monitor-state.ts`, `monitor-state.spec.ts` -- `failureEpisodeAfter`; unit cases for entering, staying in, leaving, and null to `failing`
- [x] `src/modules/monitoring/domain/monitor.domain.ts` -- `applyCheck`; `applyUpdate` uses the shared rule (no behaviour change, and `monitor.integration.test.ts` stays green)
- [x] `src/modules/monitoring/database/check-result.repository.ts`, `monitor.repository.ts`, `index.ts` -- `append`, `recordCheck`, DI registration
- [x] `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts` -- the command per Always
- [x] `src/modules/monitoring/record-check-result.integration.test.ts` -- every AC and every matrix row
- [x] `src/modules/monitoring/monitor.integration.test.ts`, `src/shared/testing/fixtures.ts` -- event list and comment

**Acceptance Criteria:**
- Given story 5.6's criteria, when `record-check-result.integration.test.ts` runs, then each is proven, and every emitted type is in DOMAIN's monitoring catalog.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass. With only postgres and mailpit running, rerun failures 2–3 times per AGENTS and report all of them.
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row, and rewrapped one comment in `fixtures.ts`.
- Verification before review, main session, 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 warnings from before, none in touched files; no dependency violations).
  - Unit tests: 221 of 221, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 514 of 514 on the first run, so no reruns. All 10 story 5.6 tests ran.
  - e2e: 3 scenarios, 42 steps. `auth:schema:check` is in sync.
- After the review pass 1 patches (same subagent; main session read them):
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 221 of 221, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 516 of 516 on the first run, so no reruns. All 12 story 5.6 tests ran.
  - e2e: 3 scenarios, 42 steps. Cucumber printed "Invalid Duration" for the total, a display quirk; every step passed. `auth:schema:check` is in sync.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1/B4 | Check-path event payloads are not asserted beyond type, `from`/`to`, and episode on two events | medium | Pre-verified: no test reads `checkedAt`, `errorCode`, `serviceId`, `monitorName`, or `state_changed.failureEpisode`; a wrong source passes. 5.10 and 5.15 build on these. patch: `deepEqual` payloads in the walk, plus a failing→healthy order case |
| B5 | "After commit" is unproven: nothing shows a failed transaction emits nothing | low | The AC requires emitting after commit; no test makes the transaction fail. A `checkedAt` in 2000 has no partition. patch: assert it rejects, with no row, counters unchanged, no event |
| B2 | The disabled rule is decided twice (`applyCheck` and the handler's `if (current.enabled)`) | low | A change to the domain rule would leave the handler writing. patch: `applyCheck` returns `counted`; the handler writes only when it is set |
| B6 | The command's returned id is never checked | low | Tests ignore `record()`'s value. patch: assert it equals the stored row's id |
| B7 | The disabled test writes the counters with raw SQL beside `setMonitorCheckState` | low | The fixture takes exactly those three fields and asserts the row exists. patch: use it |
| B8 | The lock test hangs if the holder throws before signalling | low | `await hasLock` waits forever, until the 900 s timeout. patch: race `hasLock` with `holder`. The unawaited `pending` on a failed assert is rejected: both commands succeed after release, so nothing is left unhandled |
| B9 | `CheckResultRow` widens `status` and `errorCode` | low | `errorCode: string` loses `CheckErrorCode`. patch: derive both from `CheckOutcome`, and narrow `as never` to postgres.js's `JSONValue` |
| B10 | The malformed-id test's name says "before any SQL" but does not show it | low | It asserts only 400 and no events. patch: rename to what it shows |
| B3 | Lock order can deadlock with an organization delete | low | Real: the monitor lock, then the FK `for key share` on `"organization"`, against delete's org row, then cascade into `monitors` (see the migration's own note at `20261009130000_create_check_results.sql:84`). Postgres aborts one transaction after 1 s, so either an org delete fails once or a check for a dying org is lost. It needs an org delete racing a millisecond-long record, and the fix reverses the frozen lock-first order or locks a Better Auth row from monitoring. rejected (unlikely; non-trivial). The Code Map's "no deadlock path" is wrong for this case; raised with the owner |
| B1 | A result in flight across a disable/re-enable or an edit is counted against the reset row | low | Real, but needs a re-enable within one check timeout (≤ 60 s). The fix compares against `updated_at`, which every edit moves, so it adds a rule DOMAIN does not have. rejected (unlikely; non-trivial) |
| E2 | A service archived while its check is in flight still gets state events | low | Real within one check timeout. The fix reads `services` from monitoring, whose foreign-table allowlist opens at 5.8. rejected (unlikely; non-trivial); 5.10 and 5.15 consumers read the service themselves |
| E3 | An older result recorded after a newer one moves `last_checked_at` back and can reset a newer count | low | Decided in the frozen block (review F1, last write wins). 5.8 never runs one monitor twice at once. rejected |
| E1 | `checkedAt` in a month with no partition loses the result | low | Accepted in the frozen block. The worker keeps 2 future months, and the adapters stamp the current time. rejected |
| E4 | A disabled monitor still emits a check event | false | The AC requires it: "the row is stored and `monitor.check_succeeded` or `monitor.check_failed` is emitted" |
| B11 | `applyCheck` has no unit tests | low | Every branch (disabled, reset, increment, threshold 1, episode) runs in the integration suite, which CI runs. rejected |
