---
title: 'Split runWorkerPass into named per-organization steps (Epic 5 retro item 9)'
type: 'refactor'
created: '2026-10-18'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-retro-2026-10-17.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `runWorkerPass` in `src/worker.ts` is about 185 lines. It runs three per-organization step groups inline, each in its own `try` with its own failure message, then the global partition maintenance. Epic 4 adds notification dispatch to the same pass, so the function would keep growing (retro AV-3).

**Approach:** Behaviour-preserving refactor. Each per-organization step becomes a named unit in one ordered list. `runWorkerPass` becomes discovery, then each organization through that list, then partition maintenance, then the rejection rules. Epic 4 then adds one entry to the list.

The rules:
- **Same groups and failure boundaries.** The steps keep today's three groups and their boundaries:
  1. maintenance transitions and status reconciliation share one `try`, so a failed transition still skips that organization's reconciliation
  2. draft reconciliation, whose per-monitor failures mark the organization failed and let the remaining monitors run
  3. the uptime rollup refresh
- **Same order.** The steps run in that order, and partition maintenance stays after the organization loop.
- **Same logging.** Every log message, level and field set is unchanged, and so are the scoped options (`orgIds`, `maintainPartitions`).
- **Same rejections.** The pass rejects when discovery failed, when every visited organization failed, or when partition maintenance failed, always with no cause.
- **Same callers.** Every existing test passes unchanged.
- **No other changes.** `runMonitorPass`, `startLoop`, shutdown, imports between modules, genesis documents and AGENTS.md stay as they are. Fix only a comment the refactor makes wrong, such as the duplicated doc comment above `runWorkerPass`.

</frozen-after-approval>

## Implementation Notes

- `src/worker.ts`: each per-organization step is an `OrganizationStep` (`failureMessage`, `run`) in an ordered `ORGANIZATION_STEPS` list.
  - The three steps are `transitionMaintenanceAndReconcileStatus` (one step, so a failed transition still skips reconciliation), `reconcileMonitorDrafts` (per-monitor failures return true and the remaining monitors still run) and `refreshUptimeRollups`.
  - `runOrganizationSteps` runs the list for one organization and counts it as failed once. `runPartitionMaintenance` runs after the loop.
  - `runWorkerPass` keeps discovery, the scoped options and the rejection rules unchanged.
  - The entrypoint doc comment that floated above `runWorkerPass` now sits on `startWorker`.
  - The `ORGANIZATION_STEPS` comment states the ordering dependencies, and that a new entry joins the "every organization failed" rule (relevant to Epic 4's notification step).
  - Log messages, levels, fields and order are unchanged.
- `src/modules/monitoring/draft-reconciliation.integration.test.ts`: `stubApp` gains a `transition` option.
  - A new test shows that a failed transition skips status reconciliation, the draft and rollup steps still run, and the pass rejects with one `worker pass failed for organization` error.
  - Mutation check: with the transition's error swallowed inside the step, the test fails ("Missing expected rejection"); restored afterwards.
  - The first mutation attempt (`.catch` on the returned promise) did not take effect, because the stub throws synchronously.
- `src/worker.ts` grows from 481 to 542 lines, almost all of it doc comments; `runWorkerPass` itself shrinks from about 185 lines to 42 (signature and options comments included).
- Verification (2026-10-18), all on the first run with no reruns, with `docker compose up -d` only (the `app` profile down):
  - `pnpm run check`: clean, 438 modules
  - `pnpm run test`: 262/262, and 262/262 again with `.env` moved aside
  - `pnpm run test:integration`: 644/644
  - `pnpm run test:e2e`: 4 scenarios, 53 steps
  - `pnpm run auth:schema:check`: in sync

## Review Triage Log

One reviewer (blind) ran, because the one-shot route has a single layer.

| Finding | Verdict | Evidence | Route |
|---|---|---|---|
| The entrypoint doc comment still floats above `OrganizationStep` | low | It described `startWorker`, which had none | patch: moved onto `startWorker` |
| No test pins "a failed transition skips status reconciliation" | medium | `draft-reconciliation…` failed only the reconcile; `due-maintenance…` never made the transition throw | patch: new test, mutation-checked |
| `run` returns `boolean \| undefined` where `false` and `undefined` mean the same | low | Two steps returned `undefined` | patch: `Promise<boolean>`, `return false` |
| The function `maintainPartitions` shares the option's name, and its DDL ran inside a `&&` short-circuit | low | `options.maintainPartitions === true && (await maintainPartitions(...))` | patch: renamed `runPartitionMaintenance`, plain `if` |
| The step sequence is repeated in prose in two doc comments | low | The entrypoint and `runWorkerPass` comments | patch: both point at `ORGANIZATION_STEPS` |
| The guidance for adding a step omits the health rule and the ordering dependencies | low | Epic 4's notification step faces exactly this | patch: one comment on `ORGANIZATION_STEPS` |
| No unit-level coverage of the private steps | low | Integration suites cover every step and boundary; a unit seam adds exports | rejected |
| The file grew; move the steps to their own module | low | Retro AV-3's concern is `runWorkerPass`'s size, now 42 lines; `src/worker.ts` is the composition root | rejected |
| The spec records no work or verification | false | Recorded here and in Implementation Notes at finalize | rejected |
