---
title: 'GH #150 — read a maintenance window and its services in one snapshot'
type: 'bugfix'
created: '2026-11-10'
status: 'done'
baseline_commit: '3cd6f33ed8a22b6b139e58907de37dba518fa93c'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `getMaintenanceQuery` and `listMaintenanceQuery` run `maintenanceRepository.findById` and `.list` in a default READ COMMITTED tenant transaction. Each repository call reads the window rows, then their `maintenance_services`, in a second statement. If an edit commits between the two, the answer pairs the old window fields with the new affected services, a state that never existed. The issue reproduced this three times. REST and GraphQL both use these two handlers.

**Approach:** Run both handlers' reads with `{ isolation: 'repeatable read', readOnly: true }`, as `get-incident` and the public page already do, so every statement sees the snapshot taken at the transaction's first statement. Back the claim with a test that commits an edit between the two statements (ARCHITECTURE 6.2, "Isolation"; AGENTS.md).

## Boundaries & Constraints

**Always:**
- Both handlers pass `{ isolation: 'repeatable read', readOnly: true }` as `withTenantTransaction`'s third argument. Each carries a one-line comment in `get-incident.handler.ts`'s idiom saying why.
- The test's edit commits on another connection through the real `updateMaintenanceCommand`, after the handler's window statement has returned and before its services statement runs. The test proves that order instead of assuming it.
- The DI singleton the test patches is restored in a `finally`.

**Never:**
- No production seam: no new parameter, hook or export in the handlers or the repository.
- No change to write paths. `update`, `complete` and `delete` read the window under #148's row lock.
- No change to other readers. The public page and the Atom feed already read in one snapshot. `recompute-service-status` reads in one statement. The notification pass (`queue-email-notifications.handler.ts`) reads its scanned changes and then their services in separate statements. It is a different handler, and it decides "on current rows" on purpose. Record it as deferred; do not fix it here.
- No edits to `docs/genesis/*` or `AGENTS.md`.

## I/O & Edge-Case Matrix

Seed: a scheduled window titled `Old`, covering service A. The edit is `updateMaintenanceCommand({ title: 'New', affectedServiceIds: [B] })`, committed between the reader's two statements.

| Scenario | Reader | Expected | Fails at READ COMMITTED because |
|----------|--------|----------|----------------------------------|
| Get | `getMaintenanceQuery` | title `Old`, services `[A]` | it returns `Old` with `[B]` |
| List | `listMaintenanceQuery`, entry for this id | title `Old`, services `[A]` | it returns `Old` with `[B]` |
| After | `getMaintenanceQuery` once the edit has committed | title `New`, services `[B]` | — (proves the edit landed) |

</frozen-after-approval>

## Code Map

- `src/modules/maintenance/queries/get-maintenance/get-maintenance.handler.ts:23-25` and `list-maintenance/list-maintenance.handler.ts:21-23` -- the two calls to fix. GraphQL resolvers and REST routes reach them through `queryBus`.
- `src/modules/incident/queries/get-incident/get-incident.handler.ts:22-29` -- the precedent: "findById reads the row and then its impacts: one snapshot, so a concurrent edit cannot yield old fields with new services." `{ isolation: 'repeatable read', readOnly: true }`.
- `src/shared/db/tenant-transaction.ts` -- `withTenantTransaction(orgId, work, options)`. The first statement is `set_config`, which fixes a repeatable-read snapshot before `work` runs.
- `src/modules/maintenance/database/maintenance.repository.ts` -- `findById`: `select * from maintenance where id = … limit 1 [lock]`, then the closure-local `affectedServiceIds` (`select service_id from maintenance_services where maintenance_id = …`). `list`: `select * from maintenance … order by scheduled_start_at desc, id desc`, then one batched `select maintenance_id, service_id from maintenance_services where maintenance_id in …`. The services read is not reachable on its own.
- Test seam: patch `findById` and `list` on `app.diContainer.resolve('maintenanceRepository')`. The patch calls the original with `{ ...tx, sql: gated }`, where `gated` is a `Proxy` over `tx.sql` whose `apply` trap runs the real call. When the template strings match `/\bfrom maintenance\b/` and the gate has not fired, it sets `fired = true` synchronously, inside the trap and before attaching anything. Then it returns `result.then(async (rows) => { await commitEdit(); return rows; })`. The patch is on the shared singleton, so the edit's own `findById(tx, id, { lock: 'update' })` goes through it too. Gate only a call without a `lock` option, and set the flag before `commitEdit` runs. Otherwise the edit would start a second edit that waits forever on the first edit's row lock. Leave fragment calls (`tx.sql\`\``, `tx.sql(columns)`) alone: attaching `.then` to one would execute it. The test asserts that the flag fired. The precedent is `atom-feed.integration.test.ts:557-600` ("reads every batch from one snapshot"), which patches `publicHistoryRepository` and restores it in `finally`.
- A repeatable-read reader takes no row lock, so #148's `for no key update` in the edit does not block it, and the edit's commit after the snapshot stays invisible to it.
- Fixtures: `signUpWithOrg` (`@/shared/testing/tenant`), `createService` and `scheduleMaintenance(app, cookie, { title, affectedServiceIds })` (`@/shared/testing/fixtures`). The model for setup and cleanup is `maintenance-edit-concurrency.integration.test.ts` (`newOrg`, the `created` list, `after`). Commands and queries run through `app.commandBus.execute` / `app.queryBus.execute`, followed by `app.eventBus.drain()`.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/maintenance/maintenance-read-snapshot.integration.test.ts` -- Two tests: Get, and List. Each asserts its row and then the After row, and runs `app.eventBus.drain()` after the gated read, before its assertions and cleanup (the edit emits `maintenance/updated`). The header names the sabotage: no `isolation: 'repeatable read'` in the handler. Run it against the unchanged handlers and record in Implementation Notes that Get and List fail (never commit that run). -- reproduce first.
- [x] `get-maintenance.handler.ts`, `list-maintenance.handler.ts` -- Pass the options and add the comment. -- the fix.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- Append one entry. In one READ COMMITTED transaction (`queue-email-notifications.handler.ts`), the notification pass scans changes (`scanIncidentEntries`, `scanMaintenanceChanges`) and then reads their services (`incidentServices`, `maintenanceServices`) in later statements. `publishable` therefore judges a scanned change against services that may have been edited after the scan. The handler says it decides "on current rows" on purpose, so whether this is a defect is the owner's call. Found while fixing #150 and outside it. -- record the other split.

**Acceptance Criteria:**
- Given the unchanged handlers, when the new file runs, then Get and List fail, with the gate having fired.
- Given the fix, when the new file and `read-maintenance.integration.test.ts` run, then all pass.
- Given the fix, when either handler's options are removed, then that handler's test fails.

## Implementation Notes

- Reproduction (not committed): against the unchanged handlers, both new tests failed with the gate fired, returning the old window paired with the new services.
- Sabotages (run by the orchestrator), each removing `{ isolation: 'repeatable read', readOnly: true }` from one handler and restoring it: get-maintenance fails only "get…" (services `[B]` for `[A]`); list-maintenance fails only "list…". With the fix, the new file and `read-maintenance.integration.test.ts` pass 7/7.
- The gate lets the edit's own locked `findById` through by the `fired` flag, which is set synchronously before `commitEdit` runs. The `lock` check is a second guard.
- Review patches (triage #1-#5): drain in `finally`, the list test's After check through the list handler, comments corrected, and the deferred entry rewritten. The sabotages were re-run after the patch with the same results.
- Verification: `pnpm run check` clean (11 pre-existing warnings, other files). Unit 478/478 with `.env` and without it. e2e 12/12. `auth:schema:check` in sync. Integration, reported in full:
  - before the review patch: 874/874
  - after it, full run 1: 872/874. Both failures were in `worker-health.integration.test.ts` ("fails when every organization fails", "fails when every pass rejects…", sleep-based). That file alone: 13/13 three times
  - full run 2: 873/874. "retries a transient failure on the doubling schedule, then abandons" in `send-queued-email.integration.test.ts` (timing-based) failed. That file alone: 25/25 three times
  - full run 3: 874/874
  - Neither failure repeated. Both files are untouched by this change, and `journalctl -k` logged 82 "Time jumped backwards" lines in the preceding 40 minutes: the WSL clock pitfall in AGENTS.md

## Spec Change Log

## Review Triage Log

| # | Layer | Finding | Verdict | Evidence | Route |
|---|-------|---------|---------|----------|-------|
| 1 | edge | If `read()` rejects, `drain()` is skipped and handlers spill into the next test | low | The drain sat after `await read()` inside `try` | patch |
| 2 | blind | The list test's After check reads through `getMaintenanceQuery` | low | It never shows the list handler's new state | patch |
| 3 | blind | The `lock` bypass is never reached, and its comment overclaims | low | `fired` is set synchronously before `commitEdit`; the lock check is a second guard | patch (comment) |
| 4 | blind | The gate depends on the window read being a bare awaited template matching the regex | low | The trap returns a plain Promise | patch (header note) |
| 5 | blind | The deferred entry understates the notification-pass split (a deleted window reads as org-wide, unverified) and omits that RR is not a drop-in there (writes, 40001) | medium | Entry rewritten with both, marked unverified, with what would settle it | patch (deferred-work text) |
| 6 | blind | `readOnly: true` is unpinned | low | The snapshot claim rests on `repeatable read`, which the sabotage pins; the precedents leave `readOnly` unpinned too | reject |
| 7 | blind | No delete-during-read case | low | The same snapshot covers it; the issue's race is an edit | reject |
| 8 | blind | The spec file is absent from the diff | false | By design: it is the claims file, committed with the change | reject |
| 9 | verification gap | none | — | No gaps filed | — |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean
- `pnpm run test` -- expected: all pass, also with `.env` moved aside
- `pnpm run test:integration` -- expected: all pass. Only postgres, mailpit and migrate are up
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass
