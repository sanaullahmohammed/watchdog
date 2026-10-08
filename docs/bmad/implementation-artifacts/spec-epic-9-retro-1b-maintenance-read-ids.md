---
title: 'Epic 9 retro item 1b — maintenanceWindow(id) refuses a malformed id as REST does'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: 'd41394562072bfc76a75887d0110151fee372b17'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `query { maintenanceWindow(id: "x") }` reaches Postgres and answers a masked 500 "Internal Server Error". REST refuses the same id with a 400 (retro finding DR-1).

**Approach:** The get-maintenance handler checks the id with `assertUuid` before any SQL, as `get-service-group` and (after item 1a) `get-service` do. The maintenance refusal suite gains one test that fails without the fix.

This is part 2 of 3 of retro action item 1. Part 1 (`service`) merged as d413945. `incidentTimeline` is part 3.

**Decision (owner, 2026-10-08):** 1a merged first and this branch was rebased onto `master` at d413945 before any build. The `deferred-work.md` entry at `:51` goes back to naming only `incidentTimeline`, and says `service(id)` and `maintenanceWindow(id)` were fixed by retro items 1a and 1b.

## Boundaries & Constraints

**Always:**
- `assertUuid(payload.id, 'id')` is the handler's first statement. GraphQL then answers 400 with exactly `Invalid input. id: must match format "uuid"`.
- The new test sits in `maintenance-input-validation.integration.test.ts` and mirrors 1a's test: a `$id` variable, not a literal.

**Never:**
- No change to `service`, `incidentTimeline`, the REST route schema, the SDL, or any migration.
- No change to `graphql-error-formatter.integration.test.ts`. Item 1a already moved it off product bugs onto a test-only field.
- Not consolidating the suite's local helpers. That is retro action item 4.
- Not widening `assertUuid`. A `urn:uuid:<uuid>` id still passes it and reaches Postgres. That gap is already deferred for maintenance ids (`deferred-work.md:76`) and needs no new entry.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Malformed id, GraphQL | `maintenanceWindow(id: $id)`, `$id = "not-a-uuid"` | HTTP 400, `data: null`, one error, message exactly `Invalid input. id: must match format "uuid"` |
| Malformed id, REST | `GET /api/v1/maintenance/not-a-uuid` | 400 (route schema), unchanged |
| Well-formed unknown id, GraphQL | `$id = randomUUID()` | 404 as before |
| Existing window, GraphQL | `$id = windowId` | 200, `data.maintenanceWindow.id === windowId` (positive control) |

</frozen-after-approval>

## Code Map

- `src/modules/maintenance/queries/get-maintenance/get-maintenance.handler.ts:18-23` -- the handler. Import `assertUuid` from `@/shared/validation/typebox-guard` and call it first, before `withTenantTransaction`. Its only callers are `get-maintenance.route.ts:27` and `get-maintenance.resolver.ts:26`.
- `src/modules/service/queries/get-service-group/get-service-group.handler.ts:5,22` -- the pattern to copy.
- `src/modules/maintenance/queries/get-maintenance/get-maintenance.route.ts:15,18` -- `GET /v1/maintenance/:id`, with params `format: 'uuid'`. REST already answers 400.
- `src/modules/maintenance/queries/get-maintenance/get-maintenance.graphql-schema.ts:3` -- `maintenanceWindow(id: ID!): Maintenance!`.
- `src/modules/maintenance/maintenance-input-validation.integration.test.ts`:
  - `api()` (`:36-47`) takes POST, PATCH and DELETE, and its payload is already optional. Add `'GET'`. The REST row is `api('GET', '/maintenance/not-a-uuid')`.
  - `gql()` (`:49-63`) returns `{statusCode, body:{data, errors?}}`.
  - `windowId` is assigned in `before` (`:177`).
  - The sibling test `'refuses a malformed window id, not a masked 500'` (`:284`) covers the mutations. Put the new test right after it.
  - `randomUUID` is not imported yet. Add it to the existing `node:crypto` import.
  - The docblock (`:11-16`) names only Story 9.4. Add a line naming the retro item 1b test, as 1a did.
- The 1a test to mirror: `src/modules/service/service-input-validation.integration.test.ts:423-440`.
- `docs/bmad/implementation-artifacts/deferred-work.md:51` -- the entry naming `incidentTimeline` and `maintenanceWindow`. Edit its summary only: remove the `maintenanceWindow` clause, and replace "(`service(id)` was fixed by retro item 1a)" with a note that `service(id)` and `maintenanceWindow(id)` were fixed by retro items 1a and 1b. Keep its evidence line. No other entry refers to this one, so nothing else changes.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/maintenance/queries/get-maintenance/get-maintenance.handler.ts` -- call `assertUuid(payload.id, 'id')` first -- DR-1
- [x] `src/modules/maintenance/maintenance-input-validation.integration.test.ts` -- add `'GET'` to `api()`, and add the test `'refuses a malformed id on the maintenanceWindow query over GraphQL as REST does'` covering all four matrix rows. Update the docblock.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- drop `maintenanceWindow` from the entry, leaving `incidentTimeline`, worded as the Decision in Intent says

**Acceptance Criteria:**
- Given the handler change reverted, when the maintenance suite runs, then only the new test fails, at its 400 assertion.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean
- `pnpm run test` with `.env` moved aside -- expected: all pass
- `pnpm run test:integration` -- expected: all pass. Rerun any failure a few times before treating it as real.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass

## Implementation Notes

- Implemented by a Sonnet subagent from this spec, and checked against the diff from `d413945`.
- Acceptance check, run by hand: with the `assertUuid` line removed, the maintenance suite fails only the new test, at `500 !== 400`. With it, all 10 pass.
- Review fixes #1, #3 and #4 were applied by the implementer. The REST 400's `subErrors` path is `/id`.
- Verification after the fixes: `check` clean; unit 135/135 with `.env` moved aside; integration 348/348 on the first run; e2e 42 steps passed; `auth:schema:check` in sync.

## Spec Change Log

## Review Triage Log

Three layers ran (blind hunter, edge-case hunter, verification gap) on the diff from `d413945`. Each finding was checked against the code.

| # | Layer | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | blind | The REST half asserts only the status, with no failure message and nothing showing the 400 is about `id` | low | A 400 for another reason would pass; the sibling test at `:291` passes `rest.body` | patch: assert `subErrors` paths equal `['/id']`, as 1a's ladder test does |
| 2 | blind | Only an integration test shows the check runs before SQL; a later change mapping `22P02` to 400 would pass it | false | Hypothetical code; without the check the answer is a masked 500, which the 400 assertion refuses (same as 1a #5) | reject |
| 3 | blind | The docblock says each refusal asserts no write and no event; the 1b test does not | low | Docblock `:14-15` sits above the 1b line without limiting it | patch: say it is a read and does not use `refused()` |
| 4 | blind | `deferred-work.md:76` names "the new maintenance id checks", which reads as 9.4's mutations, so the read's `urn:uuid:` gap is not clearly recorded | low | 1a added a separate entry for `service(id)` (`:172`) | patch: reword `:76` to name the mutations and the `maintenanceWindow(id)` read |
| 5 | blind | The spec is not in the diff and the revert check is not recorded | false | The spec is the claims file, kept out of the diff on purpose; the revert result goes into Implementation Notes at presentation | reject (edits this build's spec) |
| 6 | blind | One test covers four scenarios under a malformed-id title | low | Mirrors 1a's shape; each assertion carries the body as its message | reject: unlikely to mislead, splitting adds structure |
| 7 | edge | `urn:uuid:<uuid>` passes `assertUuid` and reaches Postgres as a masked 500 | low | Confirmed by the reviewer on the running database; the frozen Never excludes it and `deferred-work.md:76` records it | reject (out of scope by intent) |
| 8 | gap | No gaps | — | Every `ID!` query handler now calls `assertUuid` except `incidentTimeline`, which is part 3 | — |
