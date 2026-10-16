---
title: 'Story 5.7: Warn once per certificate before it expires'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '34540925ec808d970f244edc39f526994be23b48'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** An SSL-expiry check records its certificate's fingerprint and expiry (5.5, 5.6), but nothing tells an operator that a certificate is about to expire.

**Approach:** `RecordCheckResultCommand` gains one step. When an `ssl_expiry` result carries a certificate inside the monitor's `config.warnDays` window, the same transaction inserts a `monitor_ssl_warnings` marker with `on conflict do nothing`. After commit it emits `monitor.ssl_expiry_warning`, but only if the insert created a row.

## Boundaries & Constraints

**Always:**
- The contract is story 5.7's acceptance criteria in epics.md. The rules come from DOMAIN "SSL-expiry checks" and "MonitorSslWarning" (L296–323).
- Migration `db/migrations/20261016120000_create_monitor_ssl_warnings.sql` creates the table with these columns:
  - `org_id text not null` references `"organization"` on delete cascade
  - `monitor_id uuid not null`
  - `certificate_fingerprint text not null`
  - `certificate_expires_at timestamptz not null`
  - `warned_at timestamptz not null default now()`
  
  Its primary key is `(org_id, monitor_id, certificate_fingerprint)`. It has a tenant FK `(monitor_id, org_id)` to `monitors (id, org_id)` on delete cascade. RLS is enabled and forced, with the standard `org_id = current_setting('app.current_org_id', true)` policy. The migration also revokes `update` and `delete` from `watchdog_app`, because the marker is append-only and an edited or deleted marker would warn again. It has a `migrate:down`.
- A result is a warning candidate only when all of these hold:
  - the locked monitor's `type` is `ssl_expiry`;
  - `metadata.certificateFingerprint` and `metadata.certificateExpiresAt` are both strings;
  - `Date.parse(certificateExpiresAt) − checkedAt ≤ warnDays × 86 400 000` ms.
  
  This is a pure function, `sslWarningOf(monitor, outcome) → { fingerprint, expiresAt } | null`, in `src/modules/monitoring/domain/ssl-warning.ts`. An empty fingerprint or an unparseable expiry (`NaN`) is not a candidate. It ignores `outcome.status`, so an expired or untrusted certificate in the window warns, and a negative remaining time is inside the window. It ignores `enabled` too: a disabled monitor's result is stored and emits its check event (5.6), so it warns as well. Decided at spec review: DOMAIN is silent, and the worker never runs a disabled monitor (5.8), so this reaches only a result in flight. The fingerprint is stored exactly as 5.5 formats it, uppercase colon-separated SHA-256.
- Transaction order: lock the monitor, append the result, insert the marker (`returning`), then the 5.6 counter write. The marker's FK takes key-share locks only on the monitor row we already hold and on `"organization"`, which the result insert already key-shares. That adds no new lock path; B3 is already deferred.
- The warning changes no counter, no state and no `status`, and the check event is unchanged.
- Event `monitorSslExpiryWarningEvent` (`monitor/ssl_expiry_warning`) carries `MonitorEventPayload` plus `certificateFingerprint: string` and `certificateExpiresAt: string` (ISO). It is emitted right after the check event and before any state events. It reaches in-process handlers only.
- Tests:
  - call the command through `app.commandBus.execute` with synthetic `CheckOutcome<SslExpiryCheckMetadata>` values (5.5 proved the adapter), using `src/shared/testing` helpers;
  - make the SSL monitor with `createMonitor(app, cookie, serviceId, { type: 'ssl_expiry', target: '203.0.113.10', config: { warnDays: 14 } })`; no new fixture;
  - run no worker pass, never order rows by time, and build `checkedAt` as in 5.6.
  
  The "fresh app instance" case builds a second `buildApp`, subscribes its own capture, and closes it before the suite ends. It shares the process's `sql` pool, so it proves the marker is persisted, which is the AC's point.
- The partition-drop case goes in `check-result-partitions.integration.test.ts`, inside its existing "drops only expired partitions" test, in four steps:
  - before the existing `maintain` call, create an `ssl_expiry` monitor and record a warned result at month −13 + 5 d (expiry +1 d);
  - after the existing `partitionExists` asserts, record the same fingerprint at the current time;
  - assert no warning, captured with `src/shared/testing/events.ts`;
  - assert the marker row still exists.
  
  It does not go in a separate suite, because that file asserts partitions −13 and −12 exist or are absent, and a second file creating or dropping them concurrently would race it.

**Never:** a route, resolver or schema; worker wiring (5.8/5.9); email or realtime delivery (Epics 6, 4); draft-incident assertions (5.15); reading `check_results` to decide a warning; holding markers in memory; editing an applied migration; changing 5.6's counter or event rules.

## I/O & Edge-Case Matrix

warnDays 14 throughout, except where a row says otherwise.

| Scenario | Input / State | Expected |
|---|---|---|
| First check inside | never checked; success, expiry `checkedAt` + 10 d | marker row (expiry, fingerprint) exists; one warning with both fields |
| Same cert again | then 2 more checks of A; then the next check through a second app instance | no further warning on either app; 1 marker |
| Alternating | A, B, A, all inside the window | one warning each for A and B; 2 markers |
| Renewal | A warned; then B outside the window; then B inside the window | B's first check doesn't warn, its later check does |
| Boundary | expiry `checkedAt` + exactly 14 d; another cert at + 14 d + 1 ms | first warns, second doesn't |
| No certificate | failure `connection_refused`, metadata all null | no marker, no warning, check_failed still emitted |
| Expired | failure `certificate_expired`, expiry `checkedAt` − 1 d | one warning |
| Untrusted in / out | `certificate_untrusted`, expiry + 5 d / + 30 d | first warns, second doesn't |
| Warned, then expired | A warned while valid; A later recorded as `certificate_expired` | no second warning |
| Valid and warning | monitor already healthy (prior success outside window, so its null→healthy is not counted); then success inside | for the second record only: result `success`, `consecutive_failures` 0; events exactly check_succeeded, ssl_expiry_warning |
| Non-SSL type | http monitor whose metadata happens to have the fields | no marker, no warning |
| Disabled | disabled monitor with counters set; in-window cert | marker and one warning; counters, `last_checked_at`, episode unchanged; no state events |
| Concurrent | lock gate copied from `record-check-result.integration.test.ts:367-405`; two records of new in-window cert C | one marker, exactly one warning. The monitor lock serializes them, so the second sees the committed marker |
| Failed tx | enabled monitor; `monitorRepository.recordCheck` stubbed through `app.diContainer` to throw (restored in `finally`) | rejects; no marker, no result row, no events; a retry after restore warns once |
| Partition dropped | (partition suite) warned at month −13; partition dropped; same fingerprint now | no warning |

</frozen-after-approval>

## Code Map

- `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts` -- add the marker step inside the existing transaction and return `warning` from it; emit after the check event.
- `src/modules/monitoring/domain/ssl-warning.ts` (+ `.spec.ts`) -- new, pure `sslWarningOf`. `getForUpdate` returns `config` through `monitor.mapper.ts:40`; read `warnDays` from it.
- `src/modules/monitoring/database/monitor-ssl-warning.repository.ts` -- new. `insertIfAbsent(tx, { orgId, monitorId, fingerprint, expiresAt }) → boolean`, implemented as `insert ... on conflict do nothing returning 1`. Model it on `check-result.repository.ts`. Register it in `src/modules/monitoring/index.ts` `Dependencies`.
- `src/modules/monitoring/checks/check-outcome.ts` -- `SslExpiryCheckMetadata`, reused unchanged.
- `src/shared/events/monitor.events.ts` -- the new creator, with a doc comment.
- `db/migrations/20261009130000_create_check_results.sql` -- the RLS, FK and revoke pattern to copy. Do not edit it.
- `src/modules/monitoring/record-check-result.integration.test.ts` -- the source of the helpers to mirror (`record`, `nextTime`, the lock gate). Its `deepEqual` over every creator in `monitor.events` (L141) gains `'monitor/ssl_expiry_warning'`; change nothing else.
- `src/modules/monitoring/monitor.integration.test.ts:125` -- add `'monitor/ssl_expiry_warning'` to the registered-types list.
- `src/modules/monitoring/check-result-partitions.integration.test.ts` -- the "drops only expired partitions" test (around L250).
- `src/shared/db/tenant-rls-coverage.integration.test.ts` -- covers the new table on its own; it needs no edit.

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/20261016120000_create_monitor_ssl_warnings.sql` -- table, keys, RLS, policy, revoke, down
- [x] `src/shared/events/monitor.events.ts` -- `monitorSslExpiryWarningEvent`
- [x] `src/modules/monitoring/domain/ssl-warning.ts`, `ssl-warning.spec.ts` -- `sslWarningOf`; unit cases for the boundary ±1 ms, a negative remaining time, a non-SSL type, null metadata, an empty fingerprint, an unparseable expiry
- [x] `src/modules/monitoring/database/monitor-ssl-warning.repository.ts`, `index.ts` -- repository and DI
- [x] `record-check-result.handler.ts` -- marker step and emit
- [x] `src/modules/monitoring/ssl-expiry-warning.integration.test.ts` -- every matrix row except "Partition dropped", plus a check that `update` and `delete` on the table are refused with 42501
- [x] `check-result-partitions.integration.test.ts` -- the "Partition dropped" row
- [x] `monitor.integration.test.ts`, `record-check-result.integration.test.ts` -- add the new type to each event list

**Acceptance Criteria:**
- Given story 5.7's criteria, when the two suites run, then each criterion is proven, `tenant-rls-coverage` passes, and `monitor.ssl_expiry_warning` is the DOMAIN catalog name.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row, and confirmed `eventBus.emit` invokes handlers synchronously, so the tests that clear `emitted` right after a record lose nothing.
- `sslWarningOf` also returns null when `config.warnDays` is missing. Unreachable in practice: `monitor.domain.ts` refuses an `ssl_expiry` monitor without it.
- Verification before review, main session, 2026-10-16, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 warnings from before; no dependency violations).
  - Unit tests: 227 of 227, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 531 of 531 on the first run, so no reruns. All 15 story 5.7 tests and the extended "drops only expired partitions" test ran.
  - e2e: 3 scenarios, 42 steps. `auth:schema:check` is in sync.

- After the review pass 1 patches (same subagent; main session read them). The first-check order assertion filters out `monitor/created`, which the capture also sees from the monitor's creation:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 230 of 230, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 533 of 533 on the first run, so no reruns.
  - e2e: 3 scenarios, 42 steps. `auth:schema:check` is in sync.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1/B5 | Warning-before-state-events order is not pinned | medium | Pre-verified: the only order assertion is on a monitor that emits no state event; moving the emit below the state block passes every test. patch: full type list in the first-check test |
| V2 | Nothing proves the policy isolates tenants | medium | Pre-verified: `tenant-rls-coverage` counts policies only and every 5.7 read is as the owning org; `using (true)` would pass. patch: second org, cross-org read 0 and insert refused |
| B4 | "Once per monitor" is untested | medium | Two monitors on one host share a certificate in everyday use; every test uses a fresh monitor and unique fingerprints, so a PK without `monitor_id` would pass. patch: two monitors, one fingerprint, two warnings |
| B1 | Event comment says "in-process handlers only" as if permanent | low | DOMAIN L1405 bridges `monitor.ssl_expiry_warning` (Yes). patch: comment |
| B2 | Event comment promises "once"; DOMAIN L307 makes it at most once | low | A crash between commit and emit loses it. patch: comment |
| B6 | `sslWarningOf` unit spec misses missing `warnDays`, null metadata, non-string fingerprint | low | Branches exist with no case. patch: three unit cases |
| B7 | Fresh-app and partition no-warning assertions lack a positive control | low | `seen` subscribes to the warning only; the late record is never shown to be a candidate. patch: assert `check_succeeded` on the second app; assert the warned row is gone and a new fingerprint at the same time warns. The test title is still accurate (one partition held rows): no change |
| B8 | `on conflict do nothing` has no conflict target | low | A later unique constraint would silently suppress warnings. patch: name the primary key columns |
| B12 | Disabled test asserts only that `state_changed` is absent | low | A stray `threshold_breached` would pass. patch: exact event list |
| E1/B10 | `Date.parse` accepts zone-less strings, read as local time | low | The adapter always writes `notAfter.toISOString()` (`ssl-expiry-check.ts:146`) and `outcome` is trusted input (5.6 frozen). rejected (unreachable; adds a guard) |
| B3 | Payload lacks `checkedAt` | low | The AC names fingerprint and `certificateExpiresAt`; emit follows commit synchronously, so the event's time is the check's. rejected (adds public surface for a back-dated test case only) |
| B9 | No `CHECK` on fingerprint format | low | Only an adapter change could alter the format, and 5.5 pins it. rejected (unlikely; adds a constraint and rewrites test fixtures) |
| B11 | `emitted.length = 0` without a drain is fragile | false | `eventBus.emit` invokes handlers synchronously (`event-bus.ts:99-101`), and the capture handler pushes synchronously, so nothing arrives late |
| B13 | sprint-status says `in-progress` while the spec says `in-review` | false | Step 5 sets `review` when presenting; this workflow does not move sprint-status at review start |

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, then again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass. Run it with only postgres and mailpit up. Rerun any failure 2–3 times and report all of them.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- pass
