---
title: 'Epic 9 retro item 4 — every test uses the shared helpers in src/shared/testing/'
type: 'refactor'
created: '2026-10-09'
status: 'done'
baseline_commit: 'c76b186273a55c60c947ddaf78a46a24a9723e9e'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 9.11 added shared test helpers (`src/shared/testing/fixtures.ts`, `graphql.ts`), but only two suites import them. About 25 integration suites still define their own `createService`, `createGroup`, `declare`, `capturing` or `gql` (retro AV-2, Epic 3 item 20). A fix to one copy leaves the rest wrong.

**Approach:** Extend `src/shared/testing/` just enough to cover every copy's real behaviour, move each suite onto it, and delete the copies. This is one change across all modules, by the owner's decision (2026-10-09). The tests stay the same tests: nothing is removed, and no assertion is weakened.

## Boundaries & Constraints

**Always:**
- **The rule this enforces:** no `src/**/*.test.ts` file defines a function or arrow named `createService`, `createGroup`, `createServiceGroup`, `declare`, `declareIncident`, `capturing` or `gql`. A grep proves it.
- **Fixtures** (`createService`, `createServiceGroup`, `declareIncident`) come from `fixtures.ts`.
  - Overrides reproduce each copy's exact payload: its `name` and `slug` (copies send `{ name: slug, slug }`), `title`, `impact`, `displayOrder`, `affectedServices`, `serviceGroupId` and `isPublic`. Every incident `declare` copy sends `impact: 'major'`, and the shared default is `'minor'`. The shared random defaults apply only where a copy itself had no literal for the field.
  - A suite whose copy closed over a module `cookie` passes `app, cookie` at each call.
  - A suite whose copy returned the body (`service-group-reads` returns `{ id }`) uses the returned id.
  - Copies that did not assert 201, or asserted only `< 300`, now assert 201. That is stricter and is accepted.
- **Events:** a new `src/shared/testing/events.ts` exports two helpers, each with the copies' current behaviour, listener never removed:
  - `capturing(app, type, run)` returns `{ result, captured }`, the event objects.
  - `capturingTypes(app, types, run)` returns `{ result, seen }`, the type names in order. `due-maintenance` reads `.seen`.
- **GraphQL:** `graphql.ts` keeps `gql(app, query, { variables, cookie })` and makes it generic in its `data` type: `gql<T = Record<string, unknown>>`. It adds `headers?: Record<string, string>` to the options, and two helpers:
  - `gqlResponse(app, query, options)` returns the raw inject response, unparsed. It serves suites that read response headers or the raw body: `public-surface-bounds` (including its `limited` app at `:238` and `:317`) and `graphql-error-formatter`.
  - `gqlData<T>(app, query, options)` asserts the response has no `errors` and returns `data` as `T`. It replaces copies that asserted no errors themselves: `incident-reads:126`, `list-services:236` and `public-status-payload:138`.
  - Other body-only callers read `.body`.
  - A JSON `POST /graphql` in an integration test goes through one of these. A test whose subject is the transport itself stays inline: another method or path, a missing content type, or a malformed body. `error-logging:56` is one.
- **Request wrappers that are the subject under test** keep their own code but take a name that says so. These return a raw response or a GraphQL result, and the test asserts on the status. Examples: `postService` in `service.integration.test.ts`, `postIncident` in `declare-incident`, and `createServiceMutation` / `createServiceGroupMutation` in `service-input-validation`, which call the shared `gql`.
- The counts stay what master gives today: integration 359, unit 138, e2e 3 scenarios. These were measured on the item 3 branch, whose tree is master's. No new `.spec.ts` is added.

**Never:**
- No change to production code under `src/` outside `src/shared/testing/`.
- No change to `tests/` (the cucumber steps run against a real HTTP server, not `app.inject`).
- Not sharing `api()`, `counts()`, `rows()` or `refused()` from the `*-input-validation` suites. They are per-domain SQL and assertions, and item 4 names only the five helpers above.
- No change to any expected value, status, message or count in an assertion, except where a fixture now asserts 201 itself.
- No change to `epics.md`. Adding the shared-helper constraint is action item 5, the owner's.

</frozen-after-approval>

## Code Map

- `src/shared/testing/fixtures.ts` -- `create()` posts to `/api/v1${url}` with `{ cookie, origin: TEST_ORIGIN }`, asserts 201 and returns the id. `createService` defaults a random slug and name, `createServiceGroup` the same, and `declareIncident` a random title with `impact: 'minor'`. Each takes `overrides`.
- `src/shared/testing/graphql.ts` -- `gql` always sends `content-type: application/json`, adds the cookie when given, and returns `{ statusCode, body }`.
- `src/shared/testing/tenant.ts` -- `TEST_ORIGIN`, `signUpWithOrg`.
- **Local copies by helper, as file:line:**
  - `createService`:
    - service/archive-service:34, status-override:25, serve-service-status:69, recompute-service-status:57, list-services:36 (spreads `extra`), service-group:53, service:35 (raw response, rename), service-input-validation:126 (GraphQL wrapper, rename).
    - incident/incident-lifecycle:61, incident-detail-read:45, declare-incident:27.
    - maintenance/schedule-maintenance:30, maintenance-input-validation:174 (inline in `before`).
    - status-page/public-status-payload:85 (takes the whole payload).
  - `createGroup`: service/service-group:44, service-group-reads:32 (returns `{ id }`, takes `displayOrder`), service-input-validation:138 (GraphQL wrapper, rename), status-page/public-status-payload:76.
  - `declare`:
    - incident/incident-lifecycle:32, incident-concurrency:33, incident-reads:24 (asserts titles) and incident-updates:23, all with `impact: 'major'`; incident-detail-read:56 (whole payload); declare-incident:37 (raw response, rename).
    - service/serve-service-status:75 and recompute-service-status:63 (title `${impact} trouble`, plus `affectedServices`).
  - `capturing`:
    - Event form: service/archive-service:53, service:45, service-group:37, status-override:62; maintenance/schedule-maintenance:52, end-maintenance:65; incident/declare-incident:46.
    - Type-name form: incident/incident-lifecycle:72, maintenance/due-maintenance:102 (returns `seen` only).
  - `gql`:
    - shared/api/input-validation:45, incident/incident-input-validation:43, service/service-input-validation:47, maintenance/maintenance-input-validation:53. These close over `cookie`.
    - incident/incident-detail-read:84 and service/service-group-reads:56 (optional cookie).
    - service/serve-service-status:55 and status-page/public-status-page:59 (body only).
    - server/graphql-error-formatter:27 (raw string body, extra headers) and status-page/public-surface-bounds:41 (raw response, reads headers): these use `gqlResponse`.
    - incident/incident-reads:126 (an inline lambda returning `data` after asserting no errors).
- Paths above are under `src/modules/` unless they start with `shared/` or `server/`, which are under `src/`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/testing/events.ts` (new) and `src/shared/testing/graphql.ts` -- add `capturing`, `capturingTypes`, the generic `gql<T>`, the `headers` option, `gqlResponse` and `gqlData`, each with a docblock naming the behaviour it keeps.
- [x] Every suite in the Code Map -- import the shared helpers, adapt each call site, and delete the local copies and any imports they leave unused. Work one module at a time, running that module's suites before moving on.
- [x] Rename the subject-under-test wrappers as Boundaries says.

**Acceptance Criteria:**
- Given the tree, when `grep -rnE "(function|const|let|var) (createService|createGroup|createServiceGroup|declare|declareIncident|capturing|gql)\b" src --include='*.test.ts'` runs, then it prints nothing.
- Given the full suites, when they run, then integration is 359/359, unit 138/138 and e2e 3/3. The counts are unchanged.
- Given the diff, when its assertions are compared, then no expected value changed, other than a fixture now asserting 201.

## Implementation Notes

- Every fixture call spells out the copy's old payload, so payloads are identical. `${impact} trouble` titles are written as literals.
- Checked by hand: the acceptance grep prints nothing. Every removed `assert` line sits inside a deleted copy whose check now lives in a shared helper (201 in `create()`, no `errors` in `gqlData`), or comes back reformatted. Counts are unchanged at 359, 138 and 3.
- After review: inline setup creations moved onto the fixtures too, in `end-maintenance`, `read-maintenance`, `maintenance-scope`, `archive-service`, `public-surface-bounds` and `public-status-payload`'s `/incidents` and `/service-groups` posts. The three hand-written event captures stay, because each spans several operations or the whole suite: `incident-updates` reads its array after a second post, `incident-lifecycle:289` filters across several transitions, and `incident-detail-read` listens once in `before`.
- Verified after the review patches: the grep prints nothing; check clean; unit 138/138 with and without `.env`; integration 359/359; e2e 3/3.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Setup code still creates services, groups and incidents inline, with no status check or only `< 300`, so the name-based grep cannot see these copies (blind, verification-gap) | medium | `end-maintenance:89`, `read-maintenance:71`, `maintenance-scope:96`, `archive-service:126`, `public-surface-bounds:111/172`, and `public-status-payload`'s `post` setup calls. The intent is to delete the copies. | patch |
| 2 | Event captures built by hand with `app.eventBus.on(...push)` (blind) | low | `incident-updates:69`, `incident-lifecycle:289`, `incident-detail-read:94`. These are `capturing` written inline. | patch |
| 3 | Maintenance window fixtures (`schedule`, `createWindow`) duplicate `scheduleMaintenance` (blind) | medium | Not among item 4's five named helpers. | defer |
| 4 | `const ORIGIN` duplicates `TEST_ORIGIN` in 23 files (blind) | low | Outside the five helpers, and harmless while the values match. Recorded so the next sweep takes it. | defer |
| 5 | The `events.ts` docblock claims one listener per type per app, but every call adds a permanent listener (blind, edge) | low | Suites call it repeatedly per type. Direct doc correction. | patch |
| 6 | `gqlData` returns `null` as `T` when `data` is null without errors, and prints only the errors (blind, edge) | low | The copies printed the whole body. Direct correction. | patch |
| 7 | `type Result = GraphqlResult` is a pointless alias in two suites (blind) | low | Direct deletion. | patch |
| 8 | `capturing` returns before late async events land (edge) | low | Same behaviour as every copy, which the spec requires. | reject |
| 9 | `capturingTypes` records a duplicated type twice (edge) | low | No caller passes a duplicate. | reject |
| 10 | `gql` gives a context-free `SyntaxError` on a non-JSON reply (blind) | low | Same as every copy. Wrapping it adds a branch. | reject |
| 11 | `gqlResponse` takes a cookie through `cookie` or `headers` (blind) | low | Both work. `public-surface-bounds` sends junk and forged cookies as raw headers on purpose. | reject |
| 12 | Call sites spell `{ name, slug }` in full; a slug-only shorthand would shrink the diff (blind) | low | Changing the fixture's defaults would change other callers' payloads. Cosmetic. | reject |
| 13 | Fixture `overrides` typed as `object` let a misspelt key through (blind) | low | Pre-existing shared type. Typing every fixture is new surface. | reject |
| 14 | Leftover wrapping such as `(await gql()).body`, `{ id: await ... }` and a hand-typed `assertRefused` result (blind) | low | Cosmetic, with no named harm. | reject |
| 15 | `capturing` returns `unknown[]`, which forces casts (blind) | low | Same as the copies. | reject |
| 16 | The spec does not record counts, has no mechanical check of AC3, and its Code Map lines go stale (blind) | low | The fix edits this spec. Counts are recorded in Implementation Notes. | reject |

## Verification

**Commands:**
- The grep above -- expected: no output.
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: 138 pass.
- `pnpm run test:integration` -- expected: 359 pass. Rerun a failure a few times; WSL2's clock steps back.
- `pnpm run test:e2e` -- expected: 3 scenarios pass.
