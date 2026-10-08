---
title: 'Story 9.11 — Every GraphQL mutation runs over GraphQL'
type: 'chore'
created: '2026-10-07'
status: 'done'
baseline_commit: 'c22c00dbf5f3d592196b9e3b92293c4c2b005d6b'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Parity between REST and GraphQL is checked by matching field names. Most of the 17 GraphQL mutations have never succeeded over GraphQL in a test: the Epic 3 retrospective, item 22, counted 15 of 17. Stories 9.1, 9.3 and 9.4 added refusals, not successes. A new mutation can ship with no GraphQL test at all (audit F-09; FR27).

**Approach:** One test-only suite, `src/shared/api/graphql-mutations.integration.test.ts`.
- It keeps a registry with one entry per mutation. Each entry gives a success case, an unauthenticated case and a validation-refusal case, all sent over HTTP to `/graphql`.
- It compares the registry's keys with the merged schema's `Mutation` fields both ways. A mutation with no entry fails, and so does an entry for a mutation that no longer exists; either failure names the field.
- The few fixtures and request helpers it needs go into `src/shared/testing/`, starting retrospective item 20's shared test support.

## Boundaries & Constraints

**Always:**
- The suite imports no module (`@/modules/**`). It may import `buildApp`, `sql` and `src/shared/testing/*`, as `src/shared/api/input-validation.integration.test.ts` does. It reads the field list from `app.graphql.schema.getMutationType()`.
- **Success:** HTTP 200, no `errors`, and `Object.keys(data)` exactly `[field]`, so an entry calling the wrong field fails.
  - The result is as documented: `true` for `Boolean!`, the target's id for an update or transition, and a new id for a create or `postIncidentUpdate`.
  - Each success creates its own fresh fixtures, through REST, under one signed-in organization for the file. Several Boolean mutations return `false` on a no-op, so a fixture is never reused.
- **Unauthenticated:** the same operation with no cookie answers HTTP 200, `data` null, and `errors[0].extensions.code` `UNAUTHENTICATED`.
- **Validation refusal:** HTTP 400, `data` null, and a message starting `Invalid input.` that names the offending field. This is never a masked 500, and never a GraphQL parse error.
  - For a mutation that takes `input`, the bad value is in `input`, breaking a rule only the handler's schema can catch (a length, a pattern, a minimum, or a null for an optional-but-never-null field). It is paired with a real fixture id, because handlers check the id first.
  - For a mutation with no such rule, the bad value is a malformed `id`. That covers the six id-only mutations, and `setServiceStatusOverride`, whose only input field is an enum GraphQL itself enforces.
- **Nothing written:** after each input refusal, the case checks that nothing changed.
  - A create checks the count of the table it writes.
  - An update checks the target row, `updated_at` included.
  - `transitionIncident` and `postIncidentUpdate` check the incident row and its `incident_updates` count.
  - A malformed id matches no row, so its 400 is the proof.
- **The event bus is drained** before each "before" snapshot and after each case: earlier successes start status recomputations that write in the background. Cleanup deletes the organization and user after a final drain.

**Never:**
- No change to production code, or to the existing input-validation suites.
- No moving of other files' local helpers into `src/shared/testing/`. That migration stays in retrospective item 20.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Every mutation, success | valid arguments, signed in | 200, result as documented |
| Every mutation, no session | the same operation without a cookie | 200, `UNAUTHENTICATED`, `data` null |
| Every mutation, invalid argument | the rule-breaking `input` value, or a malformed id | 400, `Invalid input.` naming the field, nothing written |
| Missing entry | a `Mutation` field with no registry entry | the suite fails, naming the field |
| Stale entry | a registry entry with no such field | the suite fails, naming the entry |

</frozen-after-approval>

## Code Map

- The 17 mutations, each in `src/modules/<m>/commands/<slice>/<slice>.graphql-schema.ts`:
  - Taking `input`: `createService`, `updateService`, `createServiceGroup`, `updateServiceGroup`, `setServiceStatusOverride`, `createIncident`, `updateIncident`, `transitionIncident`, `postIncidentUpdate`, `scheduleMaintenance`, `updateMaintenance`.
  - Taking only `id`, returning `Boolean!`: `archiveService`, `restoreService`, `clearServiceStatusOverride`, `deleteServiceGroup`, `deleteMaintenance`, `completeMaintenance`.
  - Every command taking an id calls `assertUuid`.
- Success prerequisites:
  - Restore needs an archived service.
  - Clear-override needs an override set first.
  - `deleteMaintenance` needs a `scheduled` window. `completeMaintenance` can complete a `scheduled` window (`maintenance.state-machine.ts:21`).
  - `transitionIncident` from a manual incident's `investigating` to `identified`.
  - Maintenance times must be in the future, as at `input-validation.integration.test.ts:112-120`.
- Rules to break are written once in each slice's `.schema.ts`, e.g. the service `name` and `slug` lengths and patterns, the incident `title` maxLength of 200, and `updateMaintenance`'s `affectedServiceIds: null`. Prior refusal tests show working values: `service-input-validation`, `incident-input-validation` and `maintenance-input-validation` `.integration.test.ts`. Reuse their values; don't invent new rules.
- `src/shared/api/input-validation.integration.test.ts`
  - The import pattern to copy.
  - Its local `gql()` (`app.inject` POST `/graphql`, `content-type: application/json`, cookie).
  - Its `before`/`after` order: drain, delete the organization and user, close, `sql.end`.
- `src/shared/testing/tenant.ts` -- `signUpWithOrg`, `TEST_ORIGIN`, `captureCookie`. REST state changes need an `origin` header.
- Anonymous `/graphql` requests are rate limited at 120 per minute, per app and IP (`src/server/index.ts:41-57`). Seventeen unauthenticated cases fit; authenticated ones are not counted.
- The schema: `app.graphql.schema.getMutationType()?.getFields()` after `app.ready()` (`mercurius` `index.d.ts:293`). The guard fails if the type is missing.
- One refusal value per mutation, each verified against its slice schema and handler:

  | Mutation | Value | Names |
  |---|---|---|
  | createService | `slug: "INVALID SLUG!"` | slug |
  | updateService | `name: ""` | name |
  | createServiceGroup | `slug: "Has Space"` | slug |
  | updateServiceGroup | `displayOrder: -1` | displayOrder |
  | createIncident | `title: "x".repeat(201)` | title |
  | updateIncident | `title: ""` | title |
  | transitionIncident | `{ status: identified, message: "" }` | message |
  | postIncidentUpdate | `message: "   "` | message |
  | scheduleMaintenance | `scheduledStartAt: "the day after tomorrow"` | scheduledStartAt |
  | updateMaintenance | `affectedServiceIds: null` | affectedServiceIds |
  | setServiceStatusOverride and the six id-only | `id: "not-a-uuid"` | id |

- Boolean results: archive, restore, clear-override, set-override and complete return `false` on a no-op. `setServiceStatusOverride` needs a service not already holding the target status (`service.repository.ts:142`). Both deletes throw 404 rather than return `false`.
- REST is under `/api/v1/...`. Creates answer 201 `{ id }`, deletes 204, and archive, restore, override and complete 200. `origin` matters only to Better Auth; sending it is harmless.
- Table names: `services`, `service_groups`, `incidents`, `incident_updates`, `incident_service_impacts`, `maintenance`, `maintenance_services`.
- `.dependency-cruiser.js:235-253` (`not-to-dev-dep`) covers non-test files under `src`, so the new `src/shared/testing/*.ts` helpers must not import a devDependency at runtime.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/testing/graphql.ts` (new) -- `gql(app, query, { variables, cookie })`. It returns `{ statusCode, body }`, with `body` typed `{ data, errors? }`. It omits the cookie header entirely when there is no cookie.
- [x] `src/shared/testing/fixtures.ts` (new) -- REST helpers, each returning an id:
  - `createService(app, cookie, overrides?)`
  - `createServiceGroup(app, cookie, overrides?)`
  - `declareIncident(app, cookie, overrides?)`
  - `scheduleMaintenance(app, cookie, overrides?)`

  Slugs and titles are unique per call.
- [x] `src/shared/api/graphql-mutations.integration.test.ts` (new) -- the registry and the coverage guard. One `describe` per registry entry, holding its three cases.
  - "Nothing written" is read through `withTenantTransaction` from `@/shared/db/tenant-transaction`; the callback receives `{ sql }`. That is not a module.
  - The guard's failure message lists every missing and stale name.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when the suite runs, then the outcome matches.
- Given one registry entry removed locally, when the suite runs, then the guard fails naming that field. Confirm this by hand, then restore the entry.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean. dependency-cruiser passes.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice -- expected: all pass, including 17 × 3 cases and the guard. Re-run a timeline-order failure; it is this machine's clock.
- `pnpm run test:e2e` -- expected: all scenarios pass.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op.

## Implementation Notes

- No production code changed. The new shared helpers are `src/shared/testing/graphql.ts` (`gql`) and `src/shared/testing/fixtures.ts`.
- Review patches applied:
  - The field check is anchored on `assertMatchesSchema`'s `<field>: ` format, with no case flag.
  - Creates assert their new id differs from the input and exists in its table.
  - The no-session case drains the bus and checks that nothing was written.
  - The `gql` comment is corrected.
- Checked by hand: a wrong `field` name fails its refusal case. Renaming one registry entry makes the guard fail with `mutations with no registry entry: [completeMaintenance]; entries for mutations that do not exist: [completeMaintenanceX]`.
- Verified: check clean; unit 123/123 with and without `.env`; integration 338/338 twice; e2e 3/3; auth schema in sync; `db:seed` a no-op.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The "names the field" regex is unanchored and case-insensitive, so the seven `id` refusals pass whatever field is named (blind, gap, edge ×2) | medium | `.*id` matches "uuid" and "valid"; the gap layer ran `assertUuid('not-a-uuid', 'serviceId')` and the regex matched | patch |
| 2 | A `new-id` result is only shape-checked: `postIncidentUpdate` returning the incident id, or a create persisting nothing, passes (blind, edge ×2) | medium | The success case asserts only the UUID pattern | patch |
| 3 | The no-session case neither drains the bus nor checks that nothing was written (blind, edge ×2) | low | The spec drains after each case; `snapshot` already exists | patch |
| 4 | `gql`'s comment says "as a browser would", but it sends no `Origin` (blind) | low | `src/shared/testing/graphql.ts:14` | patch |
| 5 | Success cases check the answer, not the effect, for updates and Boolean mutations (blind) | low | Resolvers are thin pass-throughs to their command; creates are covered by #2 | reject |
| 6 | A refusal does not prove no event was emitted; the anonymous case never sends a forged cookie or invalid input (blind) | low | Handlers validate before SQL and emit; anonymity by session is Story 9.2's suite; `authenticated-surface.spec.ts` pins the context call | reject |
| 7 | The guard's failure path is checked only by hand (blind) | low | A plain set difference, confirmed failing by hand as the spec asks | reject |
| 8 | Refused creates count only the main table; `updateMaintenance`'s snapshot omits `maintenance_services` (blind, edge) | low | Validation runs before any SQL, and each write is one transaction with the main row | reject |
| 9 | `after()` throws if `before()` failed; `gql` does not report a non-JSON body clearly (edge, blind) | low | Only after an already-reported failure | reject |
| 10 | The test keeps its own `rest`/`ok`/`HOUR` and setup steps instead of fixtures (blind) | low | The spec moves only the helpers this suite needs; the wider migration is retrospective item 20 | reject |
| 11 | 9.10 closed in this diff; statuses differ; spec untracked; empty notes (blind) | false | The owner asked for 9.10's bookkeeping here; step 5 sets review; the spec is withheld by design | reject |
