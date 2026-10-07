---
title: 'Story 9.3 — GraphQL refuses what REST refuses: incidents'
type: 'bugfix'
created: '2026-10-07'
status: 'done'
baseline_commit: '40e994d6b73d0dd576333f5dcf3b5e3ec9110fe4'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Over GraphQL, the incident mutations store input that REST refuses. Investigation found these rules unapplied on the GraphQL path:
- `title` length 1..200 (create, update);
- `message` length 1..4000 (create, transition; post-update lacked only the 4000 maximum);
- `startedAt` date-time format: the resolver's `new Date()` accepts `"2026-10-07"` and `"2026-10-07T10:00:00"` (no timezone, read as server-local time), which REST refuses;
- `affectedServices[].serviceId` UUID format (create, update);
- the incident `id` UUID format (update, transition, post-update), which today reaches Postgres as a masked 500;
- explicit `null` for an optional field (create `message` and `startedAt`, transition `message`), which REST refuses.

Already applied by GraphQL itself: the impact and status ladders (SDL enums) and required fields.

**Approach:** As in Story 9.1, each of the four handlers checks its destructured input against its slice's TypeBox request schema with `assertMatchesSchema`, and checks the id with `assertUuid`, before any SQL or emit. The create command carries `startedAt` as the request's string, and the handler converts it to a `Date` only after the check.

## Boundaries & Constraints

**Always:**
- One source per rule: the slice `*.schema.ts`. A refusal writes nothing and emits nothing, and throws `ArgumentInvalidException`.
- Keep `assertNoDuplicates` and its "more than once" message: the schemas have no `uniqueItems`.
- Every existing test keeps passing. `pnpm run db:seed` still works.

**Never:**
- No change to the SDL, the TypeBox schemas, any migration, queries, or other modules (maintenance is Story 9.4).
- No hand-written per-field checks in handlers.

## I/O & Edge-Case Matrix

| Scenario | Input (GraphQL) | Expected |
|---|---|---|
| Title bounds | create/update `title` `""` or 201 chars | Refused; message names `title` |
| Message bounds | create/transition/post `message` `""` or 4001 chars; post `"   "` | Refused; names `message` |
| Date only | create `startedAt: "2026-10-07"`, `"2026-10-07T10:00:00"` or `"not a date"` | Refused; names `startedAt` |
| Leap second | create `startedAt: "2026-10-07T23:59:60Z"`: passes the format, but `new Date()` gives Invalid Date | Refused with 400 on both surfaces (REST is a masked 500 today); names `startedAt` |
| Bad service id | `affectedServices: [{serviceId: "nope", impact: minor}]` on create/update | Refused before any lookup |
| Malformed id | update/transition/post `id: "not-a-uuid"` | Refused, not a masked 500; names `id` |
| Null optional | create `message: null` or `startedAt: null`; transition `message: null`; update `title: null` | Refused, as REST refuses |
| Bad ladder value | `impact: severe`, `status: closed` | Refused by GraphQL's enum, nothing written |
| Valid input | any surface | Same rows and events as today |

Every refusal: status < 500, no row or timeline entry written, no incident event.

</frozen-after-approval>

## Code Map

- `src/shared/validation/typebox-guard.ts` -- `assertMatchesSchema`, `assertUuid`; ajv with ajv-formats already registers `date-time` and `uuid`. Reuse; one change only (task 1).
- `src/modules/incident/commands/<slice>/<slice>.schema.ts` (four slices) -- the rule sources. Do not edit. The `id` param is declared inline in each route, not in a schema file.
- `create-incident.handler.ts:33-43` -- destructures `{orgId, userId, message, ...props}`, calls `assertNoNullFields` and `assertNoDuplicates`, then `incidentDomain.declareIncident`. `CreateIncidentProps.startedAt` (`incident.domain.ts:12`) is a `Date`.
- `create-incident.resolver.ts:25-30` -- spreads `args.input` and replaces `startedAt` with `parseOptionalDate(...)`. `create-incident.route.ts:26-31` converts with `new Date(...)`.
- `update-incident.handler.ts:33-40` -- `{orgId, id, affectedServices, ...patch}`, `assertNoNullFields(payload)`.
- `transition-incident.handler.ts:42-45` -- `{orgId, id, status, userId, message}`, `assertNoNullFields(..., {nullable: ['userId','message']})`. The ladder check `assertTransition` stays inside the transaction.
- `post-incident-update.handler.ts:27-31` -- payload key is `incidentId`. The SDL argument and the REST param are both `id`. `assertNotBlank` is redundant with the schema's `pattern: '\S'`.
- `db/seeds/seed.ts:188-200` -- passes `startedAt: new Date(...)`.
- `src/shared/validation/input.ts` -- keep. Maintenance still uses `assertNoNullFields`, `assertNotBlank` and `parseOptionalDate`.
- `src/modules/service/service-input-validation.integration.test.ts` -- the pattern to copy:
  - `signUpWithOrg`, `gql`/`api`, `assertRefused`, `refused()`;
  - row snapshot plus counts;
  - `before` asserts the listener registered every event type.
- Tables:
  - `incidents`: title, status, impact, started_at, updated_at;
  - `incident_service_impacts`;
  - `incident_updates`, which is append-only, so compare its count per incident.
- Events (`src/shared/events/incident.events.ts`): created, updated, confirmed, state_changed, resolved, dismissed, update_posted.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/validation/typebox-guard.ts` + its `.spec.ts`
  - Change: name at most 10 fields in the message, then `; and N more`.
  - Why: a long `affectedServices` list of bad ids would otherwise echo one entry per item. This closes 9.1 triage #34, "revisit in 9.3".
  - Unit test: 12 bad items give 10 named fields plus "and 2 more".
- [x] The four incident handlers -- call `assertMatchesSchema` on the destructured request fields first, never on `orgId`/`userId`, and `assertUuid(id, 'id')` (post-update: `incidentId`, named `id`).
  - Remove `assertNoNullFields` from all four, and `assertNotBlank` from post-update.
  - Remove the "GraphQL cannot express" comment from all four handlers.
- [x] `create-incident.handler.ts`, `.resolver.ts`, `.route.ts`, `db/seeds/seed.ts`
  - The payload type becomes `Omit<CreateIncidentProps, 'startedAt'> & { startedAt?: string | null; ... }`, carrying the request's value. Keep `| null` on `startedAt` and `message`: GraphQL hands null at runtime, and the guard refuses it.
  - After the check, the handler converts with `parseDate` from `input.ts`, which refuses Invalid Date with a 400.
  - The resolver and route pass it through unparsed.
  - The seed passes `.toISOString()`.
- [x] `src/modules/incident/incident-input-validation.integration.test.ts`
  - Cover: one GraphQL refusal per matrix row and surface it names; `refused()` asserts the message starts with `Invalid input.` and names the field (ladder rows: match GraphQL's own `does not exist in "IncidentImpact"` / `"IncidentStatus"` error; "nothing written" there is trivially true and is not evidence for the handler); for update and transition, the incident row and its impacts read back unchanged; `incident_updates` count unchanged; no incident event.
  - `before` asserts all seven incident event types are registered.
  - Accepting controls: a valid create with full `startedAt`, `message` and `affectedServices` persists and emits `incident/created`; a valid transition and post-update succeed; GraphQL duplicate `affectedServices` still says "more than once".
  - REST controls (400): create with a 201-char title, with date-only `startedAt`, with the leap-second `startedAt`, and with `message: null`; transition with `message: null`.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`, in the existing format.

**Acceptance Criteria:**
- Given any matrix row over GraphQL, when sent, then the outcome matches the matrix.
- Given the same invalid input over REST, when sent, then it is still a 400.
- Given the seed's `createIncidentCommand` call, when `tsc` runs, then it compiles against the string `startedAt`.

## Design Notes

The story's Files line names only the handlers and a test. The guard, the create resolver and route, and the seed change too: the create handler can only check `startedAt`'s format if it receives the request's string, and the guard cap was left for this story by 9.1's triage #34.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `assertNotBlank` is dead after post-update moved to the schema; Code Map says maintenance uses it (blind, edge) | low | grep: no caller outside `input.ts` and its spec | patch (delete) |
| 2 | The `; and N more` cap is tested only above the limit; `more >= 0` would pass (gap, blind) | low | Only the 12-item case asserts the suffix | patch |
| 3 | Explicit null for `affectedServices` (create, update) and `impact` (update) is unpinned after `assertNoNullFields` went (blind) | low | Schema refuses them; no test sends them | patch |
| 4 | REST control missing for update `title: null`, a matrix row (blind) | low | `api('PATCH', ...)` never called | patch |
| 5 | Valid-path test checks only `incident/created`, not the events or rows of transition, post and edit (blind) | low | Test drains but never asserts | patch |
| 6 | Leap-second refusal says "must be an ISO date-time" without the `Invalid input.` prefix (blind, edge) | low | `parseDate` message; true but rare input, and the fix adds a branch | reject |
| 7 | No REST success test for the changed `startedAt` path (blind) | false | `public-status-payload.integration.test.ts:274` creates over REST with `startedAt` and reads it back at :693 | reject |
| 8 | `\bfield\b` can match a different field's path (blind) | low | No case in this file produces a misleading match; tightening breaks the leap-second row | reject |
| 9 | `startedAt === null` arm is unreachable (blind) | false | Needed to narrow `string \| null` for TypeScript; the spec keeps `\| null` on purpose | reject |
| 10 | Spec status, sprint status and the unchecked deferred task disagree (blind) | false | Step 5 sets sprint status to review; the deferred task closes with this triage | reject |
| 11 | Id checked before the body, so one request names only `id` (blind) | low | Same design as 9.1 triage #38 | reject |
| 12 | Command payload now takes a wire-format string (blind) | low | Decided in the approved spec; the type comment says so | reject |
| 13 | Sprint-status edit includes 9.2's bookkeeping (blind) | false | The owner asked for it in this story's commit | reject |
| 14 | Whitespace-only `message` accepted on create and transition, both surfaces (blind) | medium | Schemas have `minLength: 1` without post-update's `\S` pattern; pre-existing | defer |
| 15 | `affectedServices` has no `maxItems`; a huge list is fully validated (blind) | low | Pre-existing on both surfaces; bounded by the body limit | defer |
| 16 | `startedAt` with an offset can land outside years 1..9999, e.g. `9999-12-31T23:59:59-23:59`, a masked 500 (edge) | medium | Probe: `toISOString()` gives `+010000-...`; pre-existing on both surfaces, same root as the year-0000 entry | defer |
| 17 | `incidentTimeline(id: "not-a-uuid")` reaches Postgres as a masked error (gap, other) | medium | `get-incident-timeline.handler.ts:36` calls `findById` with no check; queries are outside this story | defer |

## Implementation Notes

- Review patches applied: `assertNotBlank` deleted (no caller left); cap boundary cases (10 and 11 items); GraphQL null refusals for `affectedServices` (create, update) and `impact` (update); a REST `PATCH` `title: null` control; event and row read-backs on the accepting path. The implementer reported the three null cases as added when they were not; they were added and run by the orchestrator (9/9).
- Intermittent integration failures, not caused by this story: three incident timeline tests failed in about 4 of 45 full runs on the branch (0 of 20 on the baseline). Cause: the database clock steps back up to 1.4 s several times a minute on this machine (Docker Desktop on WSL2), and timeline order uses `clock_timestamp()`. Logged in deferred-work.md.
- `db:seed` was a no-op (`acme-demo` exists); `tsc` covers its changed call.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass both times.
- `pnpm run test:integration`, twice -- expected: all pass both times.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds. If `acme-demo` already exists it is a no-op and only `tsc` covers the changed call; say so when presenting.
