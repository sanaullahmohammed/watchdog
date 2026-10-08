---
title: 'Epic 9 retro item 1c — incidentTimeline(id) refuses a malformed id as REST does'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: '78971981f070b98003fcea9fc9982f7a642d442f'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `query { incidentTimeline(id: "x") }` reaches Postgres and answers a masked 500 "Internal Server Error". REST refuses the same id with a 400 (retro finding DR-1).

**Approach:** The get-incident-timeline handler checks the id with `assertUuid` before any SQL, as `get-incident` already does. The incident refusal suite gains one test that fails without the fix.

This is part 3 of 3 of retro action item 1. Part 1 (`service`) merged as d413945, part 2 (`maintenanceWindow`) as 7897198. With this part merged, item 1 is complete, so the `deferred-work.md` entry at `:51` is removed rather than reworded.

## Boundaries & Constraints

**Always:**
- `assertUuid(payload.incidentId, 'id')` is the handler's first statement. The payload field is `incidentId`, but the caller sent `id` over both surfaces, so the refusal names `id`, as `post-incident-update.handler.ts:32` does. GraphQL then answers 400 with exactly `Invalid input. id: must match format "uuid"`.
- The new test sits in `incident-input-validation.integration.test.ts` and mirrors 1b's test: a `$id` variable, not a literal.

**Never:**
- No change to `service`, `maintenanceWindow`, the REST route schema, the SDL, or any migration.
- No change to `graphql-error-formatter.integration.test.ts`. It no longer pins any product bug.
- Not consolidating the suite's local helpers. That is retro action item 4.
- Not widening `assertUuid`. A `urn:uuid:<uuid>` id still passes it and reaches Postgres. That gap is recorded by rewording the existing 1a entry, not by a new one.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Malformed id, GraphQL | `incidentTimeline(id: $id)`, `$id = "not-a-uuid"` | HTTP 400, `data: null`, one error, message exactly `Invalid input. id: must match format "uuid"` |
| Malformed id, REST | `GET /api/v1/incidents/not-a-uuid/updates` | 400 (route schema), `subErrors` paths `['/id']`, unchanged |
| Well-formed unknown id, GraphQL | `$id = randomUUID()` | 404 as before |
| Existing incident, GraphQL | `$id = incidentId` | 200, `data.incidentTimeline` is a non-empty array (positive control) |

</frozen-after-approval>

## Code Map

- `src/modules/incident/queries/get-incident-timeline/get-incident-timeline.handler.ts:25-31` -- the handler. Its payload is `{ orgId, incidentId }`. Import `assertUuid` from `@/shared/validation/typebox-guard` and call it first, before the destructure at `:30`. Its only callers are `get-incident-timeline.route.ts:30-33` and `get-incident-timeline.resolver.ts:27`, which both map the caller's `id` to `incidentId`.
- `src/modules/incident/queries/get-incident/get-incident.handler.ts:5,22` -- the pattern to copy.
- `src/modules/incident/queries/get-incident-timeline/get-incident-timeline.route.ts:16-20` -- `GET /v1/incidents/:id/updates`, with params `format: 'uuid'`. REST already answers 400.
- `src/modules/incident/queries/get-incident-timeline/get-incident-timeline.graphql-schema.ts:3` -- `incidentTimeline(id: ID!): [IncidentUpdate!]!`.
- `src/modules/incident/incident-input-validation.integration.test.ts`:
  - `:2` imports only `randomBytes` from `node:crypto`. Add `randomUUID`.
  - The docblock (`:11-16`) names only Story 9.3. Add a paragraph for retro item 1c, worded as `maintenance-input-validation.integration.test.ts:17-19`: it is a read, writes nothing, and does not use `refused()`.
  - `api()` (`:30-37`) takes POST and PATCH, and its payload is required. Add `'GET'` and make `payload` optional, as the maintenance suite's `api()` does (`:40-51` there). Only `'GET'` is added; this suite needs no `'DELETE'`.
  - `gql()` (`:39-53`) returns `{statusCode, body:{data, errors?}}`.
  - `incidentId` is assigned in `before` (`:157-159`). Every later write to it in this file is a refusal, so its timeline holds only the declaration. The positive control asserts a non-empty array, not an exact order, because timeline order is exposed to the WSL2 clock step (deferred `:53-55`).
  - The sibling test `'refuses a malformed incident id, not a masked 500'` (`:281-297`) covers the mutations. Put the new test right after it.
- The 1b test to mirror: `src/modules/maintenance/maintenance-input-validation.integration.test.ts:296-318`.
- `docs/bmad/implementation-artifacts/deferred-work.md` (line numbers before the removal):
  - `:50-52` -- the `incidentTimeline` entry (source `spec-9-3-graphql-incident-validation.md`). Remove all three lines. 1a removed its own entry the same way.
  - `:171-173` -- the 1a `urn:uuid:` entry for `service(id)`. Reword its summary so it names `service(id)` and `incidentTimeline(id)`, the reads fixed by items 1a and 1c. Keep its evidence line. `maintenanceWindow(id)` is already covered at `:76`.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/incident/queries/get-incident-timeline/get-incident-timeline.handler.ts` -- call `assertUuid(payload.incidentId, 'id')` first -- DR-1
- [x] `src/modules/incident/incident-input-validation.integration.test.ts` -- add `randomUUID`, add `'GET'` and an optional payload to `api()`, and add the test `'refuses a malformed id on the incidentTimeline query over GraphQL as REST does'` covering all four matrix rows. Its REST half asserts status 400 and `subErrors` paths `['/id']`, as 1b's does. Update the docblock.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- remove the `incidentTimeline` entry and reword the 1a `urn:uuid:` entry, as the Code Map says

**Acceptance Criteria:**
- Given the handler change reverted, when the incident suite runs, then only the new test fails, at its 400 assertion.

## Implementation Notes

- Implemented by a Sonnet subagent from this spec, and checked against the diff from `7897198`.
- Revert check, run by the implementer and again by hand: with the `assertUuid` line removed, the incident suite fails only the new test, at `500 !== 400`. With it, all 10 pass.
- Review fix #3 was applied by the implementer. Finding #2 was deferred to `deferred-work.md`.
- Verification after the fixes: `check` clean; unit 135/135 with `.env` moved aside; integration 349/349 on the first run; e2e 42 steps passed; `auth:schema:check` in sync.

## Spec Change Log

## Review Triage Log

Three layers ran (blind hunter, edge-case hunter, verification gap) on the diff from `7897198`. Each finding was checked against the code.

| # | Layer | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | blind | Item 1 is complete but `sprint-status.yaml:151` still says `open` | low | True after merge, but action-item statuses move in the retro and sprint-change commits (`ca74075`, `a771420`), not in story PRs; 1a and 1b left it too | reject: the owner flips it with the retro follow-up |
| 2 | blind | The retro's DR-1 prevention, a registry over `Query` fields, is missing | medium | Item 1 asks for "a malformed-id case per `Query` field", and each id-taking read now has one (`service-input-validation:424`, `maintenance-input-validation:297`, this test, `service-group-reads:193`, `incident-detail-read:343`). Nothing fails when a new read lacks one; the registry is the retro's Prevention, not an action item | defer |
| 3 | blind | The reworded `urn:uuid:` entry is unproven for `incidentTimeline` and omits `incident(id)` | low | A probe reproduced a masked 500 for `incidentTimeline(id)` and `incident(id)` with `urn:uuid:<uuid>` over both surfaces; no entry names `incident(id)` | patch: name all three reads and cite the probe |
| 4 | blind | The positive control only asserts a non-empty array, weaker than 1b's exact id | low | Timeline content and REST/GraphQL equality are covered by `incident-reads.integration.test.ts:143-156`; the control here only proves a well-formed id still reaches the read. The frozen matrix fixes the assertion | reject |
| 5 | blind | The 404 leg checks only the status, so a masked 404 would pass | false | A 404 comes only from `NotFoundException`, an `ExceptionBase` that the formatter passes through unmasked; a masked answer is always 500 | reject |
| 6 | blind | REST is not checked for the unknown-id row | low | The matrix row is GraphQL only; this diff does not change REST, and REST's 404 is unchanged | reject |
| 7 | blind | The test sits under the Story 9.3 `describe` | low | 1a and 1b placed theirs under the story `describe` too (`service-input-validation:153`, `maintenance-input-validation:169`); the docblock names the item | reject |
| 8 | blind | `api()` sends origin and an `undefined` payload on GET, and a second GET-capable copy now exists | low | Harmless, as the reviewer says; the copies are retro action item 4's work | reject |
| 9 | edge | `urn:uuid:<uuid>` passes `assertUuid` and reaches Postgres | low | Reproduced; the frozen Never excludes widening `assertUuid`, and the entry is recorded (#3) | reject (out of scope by intent) |
| 10 | edge | The found-incident branch would pass with another incident's entries | low | Same as #4 | reject |
| 11 | gap | No gaps | — | — | — |

## Verification

**Commands:**
- Revert check: remove the `assertUuid` line and run the incident suite -- expected: only the new test fails, at its 400 assertion. Restore the line and record the result in Implementation Notes.
- `pnpm run check` -- expected: clean
- `pnpm run test` with `.env` moved aside -- expected: all pass
- `pnpm run test:integration` -- expected: all pass. Rerun any failure a few times before treating it as real.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass
