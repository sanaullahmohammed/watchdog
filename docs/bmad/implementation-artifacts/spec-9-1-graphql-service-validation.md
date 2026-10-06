---
title: 'Story 9.1 — GraphQL refuses what REST refuses: services and groups'
type: 'bugfix'
created: '2026-10-06'
status: 'done'
baseline_commit: 'a771420bd2e4d0f387b481b6f6123aa8039f1543'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Over GraphQL, the service module's mutations store input that REST refuses. Audit F-01 stored a service with `name: ""`, `slug: "INVALID SLUG!"` and `displayOrder: -1`, and a malformed id reaches Postgres and comes back as a masked 500, where REST answers 400.

**Approach:** Each service-module command handler checks its input against the slice's existing TypeBox request schema, and checks any id against the UUID rule, through one shared helper. The rules stay written once, in `*.schema.ts` (ARCHITECTURE §7.1), so both surfaces refuse the same values with `ArgumentInvalidException` (400). REST's own route validation stays as early feedback.

## Boundaries & Constraints

**Always:**
- One source per rule: handlers import their sibling `*.schema.ts`, which dependency-cruiser allows. Never restate a length, pattern or minimum by hand.
- A refusal writes nothing and emits nothing: check before `withTenantTransaction` and before `eventBus.emit`.
- Throw `ArgumentInvalidException`, so GraphQL's formatter passes the message through and REST answers 400.
- Every existing test keeps passing, including `input-validation.integration.test.ts` (nulls, dates) and the REST 400s.

**Never:**
- No change to the SDL, the TypeBox schemas, any migration, or other modules (incident and maintenance are stories 9.3 and 9.4).
- No change to queries. `query { service(id: "not-a-uuid") }` still masks to 500, which `graphql-error-formatter.integration.test.ts:163` pins. It is recorded as deferred work, not fixed here.
- No hand-written per-field checks in handlers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Audit reproduction | GraphQL `createService` with name `""`, slug `"INVALID SLUG!"`, displayOrder `-1` | Refused; no row; no `service.created` | 400-class `ArgumentInvalidException`; message names `name` and `slug` |
| Name too long | create/update service or group, name of 121 chars | Refused, as REST refuses it | same |
| Bad slug | `"Has Space"`, `"-lead"`, 121 chars | Refused | same |
| Negative order / fraction | `displayOrder: -1` or `1.5` | Refused | same |
| Bad group id | `serviceGroupId: "nope"` | Refused, no FK lookup | same |
| Null on create | `createService` with `description: null` or `serviceGroupId: null` | Refused, because REST's create schema allows null for neither | same |
| Null on update | `updateService` with `description: null` | Accepted: clears it, as today | — |
| Malformed id | any service mutation with `id: "not-a-uuid"` | Refused before SQL, not a masked 500 | same |
| Valid input | either surface | Same row persisted, same event as today | — |
| `urn:uuid:` id | an id written `urn:uuid:<uuid>` | Out of scope: the uuid format of both TypeBox and ajv accepts it, so REST lets it through too. No test asserts it either way; recorded as deferred work | — |

Decided at planning (2026-10-06):
- `description: null` and `serviceGroupId: null` on GraphQL create are refused, following the REST schema. An omitted field is unchanged. On update both still accept null, which clears them.
- Id checks cover every service-module mutation that takes an id: update service, update/delete group, archive, restore, set/clear override. REST's route params already require a UUID there.
- Database tests run locally before every push (owner, 2026-10-06): Docker is enabled, and the baseline on `master` at the start of this story was 208/208 integration tests passing, with `auth:schema:check` in sync.

</frozen-after-approval>

## Code Map

- `src/shared/validation/input.ts` -- existing guards throwing `ArgumentInvalidException`. The new `typebox-guard.ts` sits beside it.
- Validation engine: **ajv**, the engine Fastify validates REST with, never `typebox/value`. TypeBox's `Value.Check` counts `maxLength` in graphemes while ajv counts code points, so `'a' + '\u0301'.repeat(200)` passes `Value.Check` and fails REST. `ajv` ^8 and `ajv-formats` 3.0.1 are direct dependencies. Use a dedicated instance matching Fastify's (`build-app.ts:39`: `keywords: ['example']`) plus `allErrors: true`, with ajv-formats' `uuid`, and no `coerceTypes`, `removeAdditional` or `useDefaults`. Cache each compiled validator per schema object in a `WeakMap`, never compiling per call. `src/shared/utils/validator.util.ts` holds an unused ajv instance; do not reuse or edit it.
- `src/shared/exceptions/exceptions.ts:19` -- `ArgumentInvalidException`, 400.
- `src/modules/service/commands/{create-service,update-service,create-service-group,update-service-group,set-status-override}/*.schema.ts` -- the rule sources. Do not edit.
- The handlers of the five slices above, plus `archive-service`, `restore-service`, `delete-service-group` and `clear-status-override`. Payloads: create `{orgId, ...props}`; update `{orgId, id, ...patch}`; set-status-override `{orgId, id, status}`; the other four `{orgId, id}`. Check the destructured `props` / `patch` (for set-status-override, `{ status }`) against the slice schema, never the whole payload, and check `id` with `assertUuid`.
- `create-service.handler.ts:33-35` -- its comment falsely claims format and length checks happen here. Correct it. `assertNoNullFields` becomes redundant in these nine handlers, because the schema decides nulls. Keep it in `input.ts`: incident and maintenance still use it. The service handlers' null messages change from "x cannot be null" to the schema's message; no service test pins the old text.
- `src/shared/api/input-validation.integration.test.ts` -- the pattern to copy: `signUpWithOrg` from `@/shared/testing/tenant`, `gql()` / `api()` helpers, and `assertRefused`.
- `src/server/graphql-error-formatter.ts` -- passes `ExceptionBase` messages through unchanged. Not edited.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/validation/typebox-guard.ts` -- add `assertMatchesSchema(schema, value)`, which validates through the cached ajv validator and throws `ArgumentInvalidException` with message `Invalid input. <field>: <message>; ...`. `<field>` is the error's `instancePath` without its leading slash; for a missing required property it is `params.missingProperty`. Each field is named once. Add `assertUuid(value, field)`, which validates through the same function against a schema built once per module, never a regex. These are the one shared mechanism 9.3 and 9.4 reuse. The docblock, not the handlers, explains why handlers validate.
- [x] `src/shared/validation/typebox-guard.spec.ts` -- unit tests for: a valid value; several errors at once, each field named once without its leading slash; a union-typed field (`Union([String uuid, Null])` given `'nope'`) named once; a missing required property named; uuid; null; and a name of 1 letter plus 200 combining marks, refused, which pins code-point counting.
- [x] The nine service handlers -- call the helpers first, before any SQL or emit, on the destructured `props` / `patch` / `{ status }`, and `assertUuid` on `id`. Remove their `assertNoNullFields` calls and their "GraphQL cannot express" comments, in all four handlers that had one, for consistency.
- [x] `src/modules/service/service-input-validation.integration.test.ts` -- one GraphQL refusal per in-scope matrix row and schema rule. `refused()` must assert:
  - the message starts with `Invalid input.` and names the field;
  - for an update, the target row (`name`, `slug`, `display_order`, `is_public`, `description`, `service_group_id`, `updated_at`) read back unchanged, besides the counts;
  - no service event.

  `before` asserts that the listener registered every service and service-group event type, so "no event" cannot pass vacuously. Also test:
  - null refused for `isPublic` (create and update), `displayOrder` (update service, update group) and `slug` (update group);
  - the code-point name over GraphQL;
  - null-on-update clearing a description and group the service actually had, read back as NULL.

  REST controls (400): service create with a bad name, slug, displayOrder and group id; group create with a 121-character name; `PATCH /services/not-a-uuid`. Test names state only what they assert.
- [x] `AGENTS.md` -- under "Conventions that differ from defaults", add exactly: "A command handler applies its slice's request schema itself, through `assertMatchesSchema` and `assertUuid` in `src/shared/validation/typebox-guard.ts`, before any SQL or emit. REST's route validation is early feedback, not the only check: SDL cannot express a length, a pattern, a minimum, or \"optional but never null\", so a handler that skips this stores what REST refuses. Older handlers that still use `src/shared/validation/input.ts` move to this as they are touched." `docs/bmad/planning-artifacts/Architecture.md` (constraints): "A command handler applies its slice's request schema itself; REST validation is early feedback, not the only check."
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- create it with one entry per item in the Review Triage Log routed `defer`, each in the form `- source_spec:` / `summary:` / `evidence:`, citing tests by name rather than line number.

**Acceptance Criteria:**
- Given any in-scope matrix row, when sent over GraphQL, then the outcome matches the matrix, and a refused row leaves the database and event bus untouched. A test asserts that the refused field's name appears in the message, not the full text.
- Given the same invalid input over REST, when sent, then it is still a 400.
- Given `pnpm run check`, when run, then dependency-cruiser reports no violation for handlers importing `*.schema.ts`.

## Implementation Notes

- Loop 0 (Sonnet implementation subagent): all tasks built. Verified on the main session: `check` passed, unit 103/103, integration 218/218 twice, `auth:schema:check` in sync. Reverted for loop 1; see the Spec Change Log.

## Spec Change Log

- **Loop 1 (2026-10-06).** Trigger: edge-case review found that TypeBox `Value.Check` counts `maxLength` in graphemes while REST's ajv counts code points; a 201-code-point name passed GraphQL and failed REST. Verified by probe. Amended: the Code Map names ajv as the engine, with a cached validator per schema; the guard and integration-test tasks gained the reviewers' verification requirements (row unchanged on refused updates, message prefix, event registration, the null cases, REST controls); and the AGENTS.md and deferred-work tasks now give exact wording and format. Known-bad state avoided: two validation engines judging one schema differently, and update refusals whose "nothing written" check could not fail. KEEP: the nine handler call sites as built (check first, on destructured `props` / `patch` / `{ status }`, `assertUuid` on `id`); the helper's two-function API and its `Invalid input. <field>: <message>` message; the test file's structure (`signUpWithOrg`, `gql`/`api`, `refused()`, the malformed-id loop over seven mutations, the 404 control for a well-formed unknown id); and the reverted implementation, kept for reference at `/tmp/claude-1000/-home-sleipnir-projects-watchdog/05dad93a-8b1a-4f00-94ce-02a1daef177b/scratchpad/story-9-1-review.diff`.

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | TypeBox counts graphemes, ajv code points; GraphQL accepts names REST refuses (edge) | high | Probe: `'a'+'\u0301'.repeat(200)`: TypeBox true, ajv false | bad_spec |
| 2 | Update refusals check only row counts, so a late write passes (blind, gap, edge) | medium | `counts()` is `count(*)`; an UPDATE leaves it unchanged | bad_spec (folded into amended test task) |
| 3 | Null-clears test is vacuous: the fixture had no description or group (blind) | low | `before` creates the service with neither | bad_spec (folded) |
| 4 | Nulls for `isPublic`, `displayOrder` on update, and `slug` on group update are untested (blind) | low | No such case in the test file | bad_spec (folded) |
| 5 | Test names claim "before SQL" and "without a foreign key lookup" without showing it (blind) | low | Assertions check only non-500 and the field name | bad_spec (folded: `Invalid input.` prefix) |
| 6 | Two test names are inaccurate (audit names; null-on-create REST claim) (blind) | low | Names contradict their own assertions | bad_spec (folded) |
| 7 | REST controls cover only some inputs (blind) | low | No group, malformed-path or displayOrder-on-create control | bad_spec (folded) |
| 8 | Event listener registration is proven only for `service.created` (blind) | medium | Refusals' "no event" would pass if registration missed a type | bad_spec (folded) |
| 9 | AGENTS.md says "service-module handlers"; queries do not apply it (blind, gap) | low | `get-service.handler.ts` has no id check | bad_spec (exact wording now in task) |
| 10 | AGENTS.md says SDL cannot express "non-null"; it can (`!`) (blind) | low | SDL `String!` exists | bad_spec (exact wording) |
| 11 | Two validation patterns coexist and the bullet has a status note (blind) | low | `input.ts` is still used by incident and maintenance | bad_spec (exact wording) |
| 12 | Comment kept in one handler, dropped in three (blind) | low | Diff | bad_spec (folded) |
| 13 | Deferred-work entries cite line numbers, are vague, and are not in BMAD format (blind) | low | File content | bad_spec (folded) |
| 14 | `assertUuid` builds a schema per call (blind) | low | Diff; matters more under ajv compilation | bad_spec (folded: cached) |
| 15 | Unit spec lacks union, nested and missing-property message shapes (blind) | low | Spec file | bad_spec (folded) |
| 16 | `assertMatchesSchema` should be a TypeScript type assertion (blind) | low | Design preference; no caller diverges | reject |
| 17 | Sprint status should say `review` (blind) | false | Step 5 sets `review` at presentation; correct for this point | reject |
| 18 | `description` has no maxLength on either surface (blind) | medium | Pre-existing in both schemas; schema edits are out of this story | defer |
| 19 | `displayOrder` ≥ 2^31 overflows the integer column into a masked 500, both surfaces (edge) | medium | Probe: both validators accept 2147483648; column is `integer` | defer |
| 20 | `urn:uuid:` ids pass both validators and reach Postgres (edge) | medium | Probe: TypeBox true; the reviewer found the ajv regex identical | defer |
| 21 | Whitespace-only names are stored on both surfaces (edge) | low | Pre-existing; a product rule | defer |
| 22 | REST coerces null to `0`, `false` or `""` before the handler, so REST accepts nulls GraphQL refuses (edge) | medium | Fastify ajv `coerceTypes`; the reviewer verified `displayOrder: null` gives 0 | defer |
| 23 | Guard's ajv registers only `uuid`; a `date-time` schema throws a plain `Error` at compile, a masked 500 (blind, edge, gap; pass 2) | medium | Probe: `unknown format "date-time" ignored in schema`, constructor `Error`. Unreachable for service schemas, certain for 9.3/9.4 | patch |
| 24 | Docblock claims the options match Fastify's, but formats differ (edge, gap; pass 2) | low | Same root as #23 | patch (with #23) |
| 25 | A missing required property inside a nested path is named bare (edge; pass 2) | low | `params.missingProperty` without `instancePath` | patch |
| 26 | ARCHITECTURE §7.1 says both surfaces refuse "with the same `ArgumentInvalidException`"; REST refuses first with Fastify's validation error (blind; pass 2) | low | `error-handler.ts` maps `FST_ERR_VALIDATION`; REST never reaches the handler check. A wording error made while writing G-6; the decision is unchanged | patch (genesis wording) |
| 27 | Deferred entry #19 says the overflow is a 500 on both surfaces, but GraphQL's `Int` refuses ≥ 2^31 itself (edge; pass 2) | low | SDL `displayOrder: Int`, a signed 32-bit scalar | patch |
| 28 | A deferred entry paraphrases a test name instead of citing it (blind, edge; pass 2) | low | Actual name: 'masks a database error a real resolver lets through, not only an injected one' | patch |
| 29 | A test name omits `isPublic` and implies `createService` `displayOrder: null`, which is untested (blind, edge; pass 2) | low | Test body | patch |
| 30 | `assertRefused` accepts GraphQL's 1.5 message for every case (blind; pass 2) | low | Global regex alternative | patch |
| 31 | Unit spec does not pin no-coercion and no-stripping (blind; pass 2) | low | The docblock promises both; no test fails if the options change | patch |
| 32 | `emitted` is not cleared before the accepting `createService`, so a stale event could satisfy it (edge; pass 2) | low | Test 'persists valid input…' | patch |
| 33 | AGENTS.md "older handlers … move to this" is ambiguous, since `input.ts` keeps `parseDate` and the others (blind; pass 2) | low | `input.ts` exports with no schema equivalent | defer (agent-context file) |
| 34 | `allErrors` can grow the message with array input (blind; pass 2) | low | Bounded by the body limit; no array fields in service schemas. Revisit in 9.3 (affected-service lists) | reject |
| 35 | GraphQL create's null refusal is not recorded in SDL or AGENTS (blind; pass 2) | low | Decided in the frozen block; the REST/GraphQL null divergence is deferred as #22 | reject |
| 36 | REST malformed-path and not-found controls exist for one route only (blind; pass 2) | low | Route params already require uuid; `assertUuid` is uniform across the seven call sites | reject |
| 37 | The `WeakMap` duplicates ajv's own cache (blind; pass 2) | low | Harmless; no named harm | reject |
| 38 | A malformed id hides other invalid fields in the same request (edge; pass 2) | low | Design choice; a second request reports them | reject |
| 39 | Incident and maintenance handlers do not apply the guard (gap; pass 2) | false (scope) | The frozen block excludes other modules; Stories 9.3 and 9.4 cover them | reject |
| 40 | The Architecture.md constraint is unqualified while incident and maintenance lag (gap; pass 2) | low | A prescriptive constraint for new work, not a status claim | reject |

## Verification

**Commands:**
- `pnpm run check` -- passes.
- `pnpm run test` -- passes, including `typebox-guard.spec.ts`.
- `pnpm run test:integration` and `pnpm run auth:schema:check` -- pass. Each needs Docker and a migrated database.
