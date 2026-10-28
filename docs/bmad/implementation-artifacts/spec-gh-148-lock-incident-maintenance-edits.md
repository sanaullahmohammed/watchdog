---
title: 'GH #148 — lock the parent row before incident and maintenance edits read it'
type: 'bugfix'
created: '2026-10-28'
status: 'done'
baseline_commit: 'a8823642f8a2719935c764aef7441dd557b498be'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `UpdateIncidentCommand` and `UpdateMaintenanceCommand` read the parent row and its affected services without a lock, then validate, write and decide whether anything changed. Under READ COMMITTED, three things go wrong:
- **(a)** Two concurrent service replacements, [A] and [B], can leave [A, B].
- **(b)** A maintenance window can start or complete between the check and the write. That lets a running window take a restricted edit, or a completed one take a service change.
- **(c)** Concurrent title edits A → B → A can emit only one update event, so subscribers and realtime clients stay stale.

The issue reproduced each of them three times.

**Approach:** Each edit takes the parent row `for no key update` before its first read and holds it through validation, the writes and change detection, all in one tenant transaction. Every other path that reads the row and then writes it takes the same lock first, so all writers lock the parent before its children. Events stay after commit. Owner decision (2026-10-28): DOMAIN.md's "*.updated" paragraph now says both edits run under the row lock. It changed first, on this branch.

## Boundaries & Constraints

**Always:**
- Lock order is parent row, then its child rows (`incident_service_impacts` or `maintenance_services`). No path may lock a service, impact or child row and then wait on an incident or maintenance row.
- `before` and `current`, the snapshots that change detection compares against, come from the locked read.
- The status checks in `maintenanceDomain.assertEditable` and `assertDeletable` judge the locked row.
- Events are emitted only after the transaction commits, as now.
- Tests never run an unscoped worker pass. A worker transition is simulated by the raw `update maintenance set status …` statement that `startDue` or `completeDue` would run, inside the held transaction.
- Concurrency tests prove blocking with `pg_blocking_pids`, never by sleeping.

**Never:**
- No migration, no schema change, no change to event payloads or to REST and GraphQL contracts.
- No change to `transitionIncident` or `postIncidentUpdate`, which already lock (`update` and `share`). No change to the worker's `startDue` and `completeDue`: each is one `UPDATE … WHERE`, which takes the row lock itself and re-checks its `WHERE` after waiting. `completeMaintenance` does take the lock: unlocked, a complete racing a delete reads `scheduled` and then finds no row, so it answers 200 `{changed: false}` for a deleted window.
- No edits to `AGENTS.md` or to other genesis text.

## I/O & Edge-Case Matrix

Each row works the same way:
1. Seed the row, then `await app.eventBus.drain()`.
2. `holdTransaction(orgId, work)` runs `work`, the concurrent writer, and holds it uncommitted. The helper locks nothing itself, so `work` must hold the parent row's lock. In the (a) rows, `work` first runs `select id from <parent> where id = $1 for no key update`, because the child writes alone do not conflict with the fixed handler's lock. In the other rows, `work`'s own `UPDATE` or `DELETE` of the parent takes the lock.
3. Start the command without awaiting it, settled so its rejection is never unhandled: `const pending = app.commandBus.execute(cmd).then((value) => ({ value }), (error) => ({ error }))`.
4. `waitUntilBlockedBy(holder.pid, …)`. In a row whose unlocked command never waits, this step's timeout is the failure.
5. Commit the holder, await `pending`, then `app.eventBus.drain()`.

Each test commits the holder in a `finally`, so a failing assertion never leaves it open. Events are captured by `incidentUpdatedEvent.type` and `maintenanceUpdatedEvent.type` (`incident/updated`, `maintenance/updated`), filtered on `payload.id`. Refusals are asserted with `instanceof`.

| Scenario | Seed / holder `work` | Command | Expected | Fails without the lock because |
|----------|--------------------|---------|----------|------------------|
| Incident (a) | incident covering [X]; holder replaces its impacts with [B] (delete, insert) | update `affectedServices: [A]` only | impacts are exactly [A] | the unlocked delete skips the holder's uncommitted B, so [A, B] remains |
| Incident (c) | title `A`; holder sets title `B` | update `title: 'A'` | title `A`; exactly one `incident/updated` for this id | `before` is the stale `A`, so no event |
| Maintenance (a) | scheduled window covering [X]; holder replaces its services with [B] | update `affectedServiceIds: [A]` only | services are exactly [A] | same merge, [A, B] |
| Maintenance (c) | scheduled, title `A`; holder sets title `B` | update `title: 'A'` | title `A`; exactly one `maintenance/updated` | stale `current`, so no event |
| Maintenance (b), running | scheduled; holder sets `status='in_progress', started_at=now()` | update `title: 'New'` | rejects with `RunningMaintenanceFieldsError` (409); title unchanged; no `maintenance/updated` | `assertEditable` saw `scheduled`, so a running window is retitled |
| Maintenance (b), completed | scheduled; holder sets `status='completed', completed_at=now()` | update `affectedServiceIds: [A]` only | rejects with `CompletedMaintenanceImmutableError` (409); services unchanged | the unlocked command never waits (a services-only patch writes no parent column, and the child writes do not conflict), so step 4 times out |
| Delete during start | scheduled; holder sets `status='in_progress'` | delete | rejects with `MaintenanceNotDeletableError` (409), not `NotFoundException` | the unlocked read saw `scheduled`, and the guarded delete then finds no row: NotFound |
| Complete during delete | scheduled; holder runs `delete from maintenance where id = $1` | complete | rejects with `NotFoundException` | the unlocked read saw `scheduled`, the guarded update then finds no row, and it answers `false` ("already completed") |
| No-op edit | unlocked, no holder | update with the current title | no event, as now | — |

</frozen-after-approval>

## Code Map

- `src/modules/incident/commands/update-incident/update-incident.handler.ts:52` -- `incidentRepository.findById(tx, id)`, unlocked. `findById` already takes `{ lock: 'update' }`, which gives `for no key update` (`incident.repository.ts:239-273`), and reads the impacts after the lock. Lines 96-100 hold a comment saying edits are not serialized; correct it.
- `src/modules/incident/commands/transition-incident/*.handler.ts:62` uses `findById(…, { lock: 'update' })`, and `post-incident-update` (~L180) uses `{ lock: 'share' }`. Both lock the incident first; leave them. `insertDraftIfAbsent` creates rows only. `lockLiveServiceInputs` (`service-status.repository.ts:57`) locks services only and reads incidents unlocked, so there is no inversion.
- `src/modules/maintenance/database/maintenance.repository.ts:209-218` -- `findById(tx, id)` has no lock option. Add `options: { lock?: 'update' } = {}` the way incident's has it, with fixed fragments only, and update `maintenance.repository.port.ts:28`. Its callers are `update-maintenance.handler.ts:69`, `complete-maintenance.handler.ts:30` and `delete-maintenance.handler.ts:32`, and all three lock.
- `src/modules/maintenance/commands/update-maintenance/update-maintenance.handler.ts:68-122` -- `findById`, then `assertEditable` (completed refuses everything; `in_progress` refuses `title`, `description` and `scheduledStartAt`; `maintenance.domain.ts:57-70`), then `assertWindow`, `update` (guard `status <> 'completed'` only; a patch with no columns returns `findById`), `replaceAffectedServices` (delete, then insert) and `changed`. Lines 106-111 hold the same "not serialized" comment; correct it.
- `src/modules/maintenance/commands/delete-maintenance/delete-maintenance.handler.ts:32-37` -- `findById`, then `assertDeletable`, then `remove` (`delete … where status='scheduled' returning *`). A null result becomes `NotFoundException`. `complete-maintenance.handler.ts:29-44` -- `findById`, a no-op if already `completed`, `assertTransition`, then `complete` (guarded `UPDATE`). A null result returns `false`. Stepping up from `no key update` to the `DELETE`'s `for update` in the same transaction is safe.
- The worker's `completeDue` and `startDue` are multi-row bare `UPDATE`s. Edits hold one maintenance row and never wait on another, so no cycle can form. FK inserts into the child tables take `for key share` on `services`, which does not conflict with recompute's `for no key update`.
- `src/modules/notification/prune-notifications.integration.test.ts:158,193` and `queue-email-notifications.integration.test.ts:225,262` -- identical local `holdTransaction(orgId, work)` → `{ pid, commit() }` and `waitUntilBlockedBy(pid, what)`, which polls `pg_blocking_pids` every 50 ms for up to 10 s. Move them to `src/shared/testing/locks.ts` and import them in both files.
- Test setup: `signUpWithOrg` (`@/shared/testing/tenant`), plus `createService` for X, A and B. Seed with `declareIncident(app, cookie, { affectedServices: [{ serviceId: X, impact: 'minor' }] })` and `scheduleMaintenance(app, cookie, { affectedServiceIds: [X] })` (`@/shared/testing/fixtures`, REST; a window an hour out). Commands run through `app.commandBus.execute(updateIncidentCommand({…}))`. Events use `capturing(app, type, run)` / `capturingTypes` (`@/shared/testing/events`) plus `app.eventBus.drain()`, filtered by id. Read rows back through `withTenantTransaction`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/testing/locks.ts` -- Move `holdTransaction` and `waitUntilBlockedBy` here unchanged. Keep the queue-email copy's extra comment ("A failure in `work` must not leave the test waiting for `started`"). Switch the two notification tests to import them and delete their local copies. -- one helper, three users.
- [x] `src/modules/incident/incident-edit-concurrency.integration.test.ts`, `src/modules/maintenance/maintenance-edit-concurrency.integration.test.ts` -- One test per Matrix row, using its own org. Run them against the unchanged handlers, confirm every locking row fails, and record that run in Implementation Notes (never commit it). -- reproduce first.
- [x] `src/modules/maintenance/database/maintenance.repository.ts`, `maintenance.repository.port.ts` -- Add the `lock` option to `findById`. -- the lock.
- [x] `update-incident.handler.ts`, `update-maintenance.handler.ts`, `delete-maintenance.handler.ts`, `complete-maintenance.handler.ts` -- Read with `{ lock: 'update' }`. Correct the two "not serialized" comments to say what the lock guarantees, citing DOMAIN. -- the fix.

**Acceptance Criteria:**
- Given the unchanged handlers, when the new tests run, then every Matrix row except the no-op fails.
- Given the fix, when both new files and the two notification files run, then all pass.
- Given the fix, when the lock in each of the four handlers is removed, then that handler's matching rows fail, by assertion or by step 4's timeout, and no holder is left open.

## Implementation Notes

- Reproduction (not committed): against the unchanged handlers, 8 of the 10 new tests failed. Seven failed by assertion; "(b) completed window" failed by the step-4 timeout, as predicted. The 2 no-op tests passed.
- Sabotages (run by the orchestrator), removing `{ lock: 'update' }` from one handler at a time and restoring it:
  - update-incident: (a) and (c) fail
  - update-maintenance: (a), (c), (b) running and (b) completed (10 s timeout) fail
  - delete-maintenance: "delete during a start" fails
  - complete-maintenance: "complete during a delete" fails
  - nothing hangs; holders commit in `finally`
- `holdTransaction` and `waitUntilBlockedBy` moved to `src/shared/testing/locks.ts`; both notification suites import them.
- Review patches (triage #1-#6): the incident header is corrected, `pending` is awaited in each `finally`, the holders' worker statements match `startDue`/`completeDue`, the asserts carry messages, and the port and repository comments are corrected. The sabotages were re-run after the patch with the same results. Biome's `useTemplate` infos in the maintenance test were fixed.
- Verification: `pnpm run check` clean (11 pre-existing warnings, other files). Unit 478/478 with `.env` and without it. Integration 872/872 on the first run, before and after the patch, with no reruns needed. e2e 12/12. `auth:schema:check` in sync.

## Spec Change Log

## Review Triage Log

| # | Layer | Finding | Verdict | Evidence | Route |
|---|-------|---------|---------|----------|-------|
| 1 | verification gap, edge, blind | The incident test header says that without the lock the command never waits and the wait times out | low | Unlocked, the incident commands still block in `updateDetails` or in the impacts `DELETE`; the orchestrator's sabotage failed them by assertion | patch |
| 2 | edge | On a failure before `await pending`, the command can outlive the test into `after()` | low | `pending` is awaited only on the happy path | patch |
| 3 | blind | `findById` port docs don't say who takes the lock | low | Maintenance's new option is undocumented | patch |
| 4 | blind | The maintenance repository comment names the wrong rows | low | The insert's FK check takes `for key share` on the parent `maintenance` row, not on the child rows | patch |
| 5 | blind | The simulated worker statements differ from `startDue`/`completeDue` | low | They omit `updated_at = now()` | patch |
| 6 | blind | Bare asserts hide what came back | low | `assert.ok(!('error' in settled))` prints `false == true` | patch |
| 7 | blind | `waitUntilBlockedBy` can't prove where the command blocked | low | The outcome assertions carry the proof: each lock's sabotage fails its rows | reject |
| 8 | blind | `holdTransaction` keeps its cast and hand-set GUC; it should pass a `TenantTransaction` | low | Tasks moved it unchanged on purpose; reshaping it touches both notification suites | reject |
| 9 | blind | The incident file repeats `against` inline | low | Duplication within one test file; harmless | reject |
| 10 | blind | REST answers change for two races (complete during a delete: 200 `{changed:false}` → 404; delete during a start: 404 → 409), and DOMAIN's maintenance state machine does not record that its commands serialize | medium | True. These are corrections, but genesis text beyond the approved paragraph is the owner's | defer (D1); listed in the PR body |
| 11 | blind | The new DOMAIN text overclaims: incident validation runs before the transaction, and the cross-client lost update (Story 9.7 deferral) remains | low | Owner-approved wording. The Story 9.7 entry stays open and is a different race (separate reads, no precondition) | reject |
| 12 | blind | No row races update against delete, incident edit against transition, or two real commands | low | The Matrix covers every consequence in the issue; transition and post-update already locked | reject |
| 13 | blind | The spec file is absent from the review diff | false | By design: it is the claims file, and it is committed with the change | reject |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean
- `pnpm run test` -- expected: all pass, also with `.env` moved aside
- `pnpm run test:integration` -- expected: all pass. Only postgres, mailpit and migrate are up. Rerun a failure 2–3 times, alone and in the suite
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass
