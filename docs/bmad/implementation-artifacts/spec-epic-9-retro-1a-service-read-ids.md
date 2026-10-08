---
title: 'Epic 9 retro item 1a — service(id) refuses a malformed id as REST does'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: 'ca74075c4a14542ecb1a9a6da3ffd8f4b9412626'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `query { service(id: "x") }` reaches Postgres and answers a masked 500 "Internal Server Error". REST refuses the same id with a 400 (retro finding DR-1). The Story 9.1 refusal suite also leaves two gaps:
- VG-1: valid input is only sent over GraphQL, so nothing shows the two surfaces store the same row.
- VG-2: nothing sends a bad status to `setServiceStatusOverride`.

**Approach:**
- The get-service handler checks the id with `assertUuid` before any SQL, as `get-service-group` already does.
- The test that pinned the masked 500 keeps proving that a real database error is masked. It gets that error from a test-only GraphQL field instead of a product bug.
- The service refusal suite gains the two missing tests.

This is part 1 of 3 of retro action item 1. `maintenanceWindow` and `incidentTimeline` are later stories, one per module.

## Boundaries & Constraints

**Always:**
- `assertUuid(payload.id, 'id')` is the handler's first statement. GraphQL then answers 400 with "Invalid input. id: must match format \"uuid\"", the same as `serviceGroup(id)`.
- The masking test still feeds a genuine `PostgresError` from the real driver through the real GraphQL error path. The test-only field is non-null (`String!`), because mercurius only answers 500 when `data` is null. The test asserts:
  - HTTP 500, with no "invalid input syntax" in the body.
  - The message "Internal Server Error", with a `correlationId` extension.
  - The original is logged under that id: level 50, and `err.message` matching `/invalid input syntax for type uuid/`. This mirrors the injected-error test at `:73`.
- The new tests sit in the service module's refusal suite and use its `refused`/`refusedFrom` helpers, so each refusal also proves nothing was written and nothing was emitted.

**Never:**
- No change to `maintenanceWindow`, `incidentTimeline`, REST route schemas, the SDL, or any migration.
- No product resolver or route added for testing. The test-only field exists only on the app instance its test builds.
- Not consolidating the suite's local helpers. That is retro action item 4.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Malformed id, GraphQL | `service(id: "not-a-uuid")` | HTTP 400, `data: null`, "Invalid input. id: …", no SQL |
| Malformed id, REST | `GET /api/v1/services/not-a-uuid` | 400 (route schema), unchanged |
| Valid unknown id | `service(id: <random uuid>)` | 404 as before |
| Real database error | test-only `String!` field running `select 'x'::uuid` | 500 "Internal Server Error" with a correlation id; original logged under it |
| Every optional field set, both surfaces | `{name, slug, description: 'd', isPublic: false, displayOrder: 3, serviceGroupId: groupId}` over REST and over GraphQL, slugs differing | equal `name`, `description`, `is_public`, `display_order`, `service_group_id` |
| Only required fields, both surfaces | `{name, slug}` over each | the same five columns are equal (defaults: `description` null, `is_public` true, `display_order` 0, no group) |
| Bad override status | `setServiceStatusOverride` with `$input = {status: "bogus"}` (a variable, not a literal); `PUT …/status-override {status:"bogus"}` | GraphQL refuses with `does not exist in "ServiceStatus"`; REST 400; no write (`manual_status_override`, `updated_at` unchanged), no event |

</frozen-after-approval>

## Code Map

- `src/modules/service/queries/get-service/get-service.handler.ts:18-36` -- the handler. Add the `assertUuid` import from `@/shared/validation/typebox-guard` and call it first. Its only callers are `get-service.route.ts:27` and `get-service.resolver.ts:25`.
- `src/modules/service/queries/get-service-group/get-service-group.handler.ts:5,22` -- the pattern to copy.
- `src/server/graphql-error-formatter.integration.test.ts:163-185` -- the masked-500 pin on `service(id:"not-a-uuid")`. Its comment calls the 400 "a separate fix", and this story is that fix. The app is built in `before` (`:55-63`), with the `logLines` logger the log assertion needs. After `app.ready()` in that `before`, call `app.graphql.extendSchema('extend type Query { … : String! }')` and `app.graphql.defineResolvers(...)` (mercurius 16.7, `node_modules/mercurius/index.js:276,292`). No other test uses them. The source-scanning specs read only `*.route.ts`/`*.resolver.ts` and module slices, so a field defined in a test file is invisible to them. The shared `sql` is safe for this: no table, no RLS.
- `src/modules/service/service-input-validation.integration.test.ts`:
  - `api()` (`:30-41`) accepts only POST and PATCH, and `payload` is required. Add PUT and GET, and make `payload` optional.
  - `assertRefused`/`refusedFrom` (`:60-80`, `:104-122`) hard-code the GraphQL-type message to `/^Variable "\$input" got invalid value 1\.5/`. Let the GraphQL-type branch take the expected RegExp. The 1.5 case passes its current pattern and the enum case passes `/does not exist in "ServiceStatus"/`.
  - REST create answers 201 `{id}` (read `JSON.parse(body).id`). GraphQL `createService` returns a bare ID (`body.data.createService`).
  - `rows()` (`:93-103`) does not select `manual_status_override`. Add it.
  - The valid-input test is at `:408-419`.
- `src/modules/incident/incident-input-validation.integration.test.ts:357` -- the ladder-refusal twin to mirror.
- `src/modules/service/commands/set-status-override/set-status-override.route.ts:14-15` -- `PUT /api/v1/services/:id/status-override`. The SDL `ServiceStatus` enum is in `src/shared/domain/status-ladders.graphql-schema.ts:17`.
- `db/migrations/20260910170120_create_services.sql:32` -- `(org_id, slug)` is unique, so the two creates need different slugs.
- `docs/bmad/implementation-artifacts/deferred-work.md:20-22` -- the Story 9.1 entry for this bug. Remove it when the fix lands. The retro's action item 8 removes entries as items close.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/service/queries/get-service/get-service.handler.ts` -- call `assertUuid(payload.id, 'id')` first -- DR-1
- [x] `src/server/graphql-error-formatter.integration.test.ts` -- replace the `service(id)` pin with a test-only Query field whose resolver runs `select 'x'::uuid` through the shared `sql`. Keep both assertions and rewrite the comment -- the test must not depend on a product bug
- [x] `src/modules/service/service-input-validation.integration.test.ts` -- add three tests:
  - (a) `service(id:"not-a-uuid")` over GraphQL → exactly 400, `data` null, "Invalid input. id", and REST GET → 400
  - (b) the two VG-1 pairs in the matrix, each comparing the five listed columns
  - (c) a bad override status is refused over both surfaces, with nothing written or emitted (VG-2)

  Widen `api()`, generalize the GraphQL-type branch of `assertRefused`, and add `manual_status_override` to `rows()`.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- delete the 9.1 malformed-query-id entry (`:20-22`)

**Acceptance Criteria:**
- Given the handler change reverted, when the integration suite runs, then the new malformed-id test fails while the formatter test still passes.
- Given a new column added to `services` later, when VG-1's test runs, then it still compares only the listed columns. Name them explicitly; never `select *`.

## Design Notes

The masking test exists to prove that genuine driver errors are masked, not that `service(id)` is broken. After all three parts of item 1, no product path is known to leak a raw Postgres error. A test-only field that runs failing SQL keeps the proof honest without waiting for, or depending on, a bug.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean
- `pnpm run test` with `.env` moved aside -- expected: all pass
- `pnpm run test:integration` -- expected: all pass. Rerun any failure a few times before treating it as real.
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass

## Implementation Notes

- Implemented by a Sonnet subagent from this spec, and checked against the diff from `ca74075`.
- The test-only field is `dbErrorProbe: String!`. It is added after `app.ready()` and resolved through the shared `sql`. The formatter suite no longer needs its `cookie` or `TEST_ORIGIN`, so the request is anonymous. It is one request, far under the anonymous limit.
- `assertRefused`/`refusedFrom` now take `'handler' | RegExp`. The 1.5 case passes its old pattern unchanged.
- Test (a) uses a `$id` variable, and also pins that a well-formed unknown id is still 404.
- Review fixes #1–#4, #6, #7 and #9–#11 were applied by the implementer. Its fix for #9 matched `/status/` against the whole REST body, and that passes on any error body because every one carries a `statusCode` key. It was replaced with an assertion that the validator's `subErrors` paths equal `['/status']`. REST's validation message is the generic "Validation error" (`src/server/plugins/error-handler.ts:19`).

## Spec Change Log

## Review Triage Log

Three layers ran (blind hunter, edge-case hunter, verification gap) on the diff from `ca74075`. Each finding was checked against the code.

| # | Layer | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|---|
| 1 | gap, blind | `deferred-work.md:51` says "as the service query in the 9.1 entry is", which points at the entry this diff deletes | low | Line 51 still reads so | patch |
| 2 | gap, blind | `maintenanceWindow(id)`'s masked 500 is no longer recorded in `deferred-work.md` | low | The only malformed-id entries left are `incidentTimeline` (`:51`); retro action item 1 tracks it, item 8 assumed the deleted entry | patch: reword `:51` to name both reads (same root as #1) |
| 3 | blind | The probe test omits `data === null`, a single error, and `err.stack` that its sibling at `:73` asserts | low | Diff shows only message, correlation id, level, `err.message` | patch |
| 4 | blind | Malformed-id test matches `/^Invalid input\. id/`, not the exact message the spec's Always names | low | Would accept another id message | patch |
| 5 | blind | Nothing shows the refusal is logged at `info`, nor that no SQL ran | false | `logFailure` level by status is covered in `error-logging` suites; SQL before the check would answer a masked 500, which the 400 assertion refuses | reject |
| 6 | blind | VG-1 compares the surfaces only with each other; both dropping `description` would pass | low | `deepEqual(gqlRow, restRow)` only | patch |
| 7 | blind | Defaults block re-queries a row the loop already read | low | Nested `withTenantTransaction` by slug | patch (deletion) |
| 8 | blind | VG-1 covers create only; update and group paths are not compared | low | Pre-existing gap, not caused here; REST null coercion is already deferred | defer |
| 9 | blind | REST half of the ladder test skips `counts()`, drains after, and does not check the 400 names `status` | low | Hand-rolled snapshot at the end of the new test | patch |
| 10 | blind | Ladder test cannot catch a bogus status clearing an override, since none is set first | low | `manual_status_override` is null before the attempts | patch |
| 11 | blind | Suite docblock and title no longer describe the VG-1 test and the retro tests | low | Header `:11-17` | patch |
| 12 | blind | Probe bypasses tenant transaction and bus; could leak into other suites' apps | false | Each `buildApp()` registers its own mercurius schema, so the field exists on that instance only; the masking path under test is the formatter, which sees the same `PostgresError` either way | reject |
| 13 | edge | `urn:uuid:<uuid>` passes `assertUuid` and still reaches Postgres as a masked 500 on `service(id)` | low | `typebox-guard.ts:78` uses `format: 'uuid'`; the same gap is already recorded for mutations, maintenance and groups (`deferred-work.md:12,76,91`) | defer |
