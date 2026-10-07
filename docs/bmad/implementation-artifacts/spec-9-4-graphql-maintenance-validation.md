---
title: 'Story 9.4 — GraphQL refuses what REST refuses: maintenance'
type: 'bugfix'
created: '2026-10-07'
status: 'done'
baseline_commit: '49626596771e7355a2b0fece610950964c2b1b12'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Over GraphQL, the maintenance mutations store input that REST refuses. Investigation found these rules unapplied on the GraphQL path:
- `title` length 1..200 (schedule, update);
- `scheduledStartAt` / `scheduledEndAt` date-time format: the resolvers' `new Date()` accepts `"2026-10-07"`, `"2026-10-07T10:00"` (read as server-local time) and `"Oct 7 2026"`, which REST refuses;
- `affectedServiceIds[]` UUID format (schedule, update);
- the window `id` UUID format (update, complete, delete), which today reaches Postgres as a masked 500;
- explicit `null` for an update date, which the update resolver silently ignores and REST refuses.

A leap second (`"...T23:59:60Z"`) passes the format but `new Date()` cannot read it: GraphQL schedule refuses it today, while REST schedule and update answer a masked 500 (`InvalidMaintenanceWindowError` calls `toISOString()` on Invalid Date).

Already applied on both surfaces: required fields (SDL `!`), nulls on other fields (`assertNoNullFields`), duplicate service ids, and the end-after-start window rule.

**Approach:** As in Stories 9.1 and 9.3, each of the four handlers checks its destructured input against its slice's TypeBox request schema with `assertMatchesSchema`, and checks the id with `assertUuid`, before any SQL or emit. Complete and delete have no schema file; their only rule is the id. The schedule and update commands carry the dates as the request's strings, and the handler converts them with `parseDate` only after the check.

## Boundaries & Constraints

**Always:**
- One source per rule: the slice `*.schema.ts`. A refusal writes nothing and emits nothing, and throws `ArgumentInvalidException`.
- Keep `assertNoDuplicates` and the domain rules (`assertWindow`, `assertEditable`, `assertDeletable`) where they are.
- `description: null` keeps clearing the description on update.
- `pnpm run db:seed` still works.

**Never:**
- No change to the SDL, the TypeBox schemas, any migration, queries, or other modules.
- No change to `transition-due-maintenance`, which has no request surface.
- No hand-written per-field checks in handlers.

## I/O & Edge-Case Matrix

| Scenario | Input (GraphQL) | Expected |
|---|---|---|
| Title bounds | schedule/update `title` `""` or 201 chars | Refused; message names `title` |
| Loose date | schedule/update `scheduledStartAt` `"2026-10-07"`, `"2026-10-07T10:00:00"`, `"Oct 7 2026"`, `"the day after tomorrow"` | Refused; names `scheduledStartAt` |
| Leap second | schedule/update `scheduledEndAt: "2026-10-07T23:59:60Z"` | Refused with 400 on both surfaces (REST is a masked 500 today); names `scheduledEndAt` |
| Bad service id | `affectedServiceIds: ["nope"]` on schedule/update | Refused before any lookup |
| Malformed id | update/complete/delete `id: "not-a-uuid"` | Refused, not a masked 500; names `id` |
| Null date on update | `scheduledStartAt: null` or `scheduledEndAt: null` | Refused, as REST refuses |
| Other nulls | update `title: null`, `affectedServiceIds: null`; schedule `affectedServiceIds: null` | Still refused |
| Null description | update `description: null` over GraphQL | Accepted; stored as NULL. (REST stores `""` today; deferred, not changed here) |
| Valid input | any surface | Same rows and events as today |

Every refusal: status < 500, no row written or changed, no maintenance event.

</frozen-after-approval>

## Code Map

- `src/shared/validation/typebox-guard.ts` -- `assertMatchesSchema`, `assertUuid`. Reuse unchanged. ajv accepts a key whose value is `undefined` as absent, so passing destructured optional fields is safe.
- `src/modules/maintenance/commands/{schedule,update}-maintenance/*.schema.ts` -- the rule sources. Do not edit. Complete and delete have none; their route declares `id` inline as a uuid.
- `schedule-maintenance.handler.ts:27-52` -- payload `ScheduleMaintenanceProps & {orgId, userId}` (`types.ts:11`, dates as `Date`). It calls `assertNoNullFields(..., {nullable: ['description','userId']})` at :35, then `assertNoDuplicates` at :36, then `maintenanceDomain.scheduleMaintenance` (runs `assertWindow`). SQL starts at :43.
- `update-maintenance.handler.ts:30-109` -- payload `{orgId, id, affectedServiceIds?, ...UpdateMaintenanceProps}`. It calls `assertNoNullFields(..., {nullable: ['description']})` at :38. The transaction opens at :41. `assertEditable` and `assertWindow` run inside it.
- `complete-maintenance.handler.ts:20-54`, `delete-maintenance.handler.ts:20-49` -- `{orgId, id}`, no checks today.
- Date parsing to remove:
  - `schedule-maintenance.resolver.ts:27-34` (`parseDate`);
  - `update-maintenance.resolver.ts:27-34` (`parseOptionalDate`);
  - `schedule-maintenance.route.ts:31-32` and `update-maintenance.route.ts:31-36` (`new Date`).
- `db/seeds/seed.ts:222-235` -- passes `Date`s to `scheduleMaintenanceCommand`.
- `src/modules/maintenance/due-maintenance.integration.test.ts:164` -- calls `updateMaintenanceCommand` without dates. Unaffected.
- `src/shared/api/input-validation.integration.test.ts` -- two tests pin messages that change:
  - :166 `/scheduledStartAt must be an ISO date-time/`;
  - :185 `/affectedServiceIds cannot be null/`.
  - :197 (`description: null` succeeds) must keep passing.
- `src/modules/incident/incident-input-validation.integration.test.ts` -- the test pattern to copy: `refused()`, row snapshot plus counts, and event registration in `before`.
- Tables: `maintenance` (title, description, status, scheduled_start_at, scheduled_end_at, updated_at) and `maintenance_services`.
- Events (`src/shared/events/maintenance.events.ts`): created, updated, started, completed, deleted.

## Tasks & Acceptance

**Execution:**
- [x] The four maintenance handlers
  - Call `assertMatchesSchema` on the destructured request fields first, never on `orgId`, `userId` or `id`. Update checks `{ ...patch, affectedServiceIds }`, since `affectedServiceIds` is destructured apart from `patch`.
  - Call `assertUuid(id, 'id')` in update, complete and delete.
  - Remove `assertNoNullFields` from schedule and update, since the schema decides nulls.
- [x] Schedule and update handlers, resolvers, routes, plus `db/seeds/seed.ts`
  - Payload types become `Omit<..., 'scheduledStartAt' | 'scheduledEndAt'>` with `string` dates: required on schedule; `string | null` and optional on update, so the guard sees and refuses null.
  - The handler converts the dates with `parseDate` after the check.
  - Resolvers and routes pass the strings through unparsed.
  - The seed passes `.toISOString()`.
- [x] `src/shared/validation/input.ts` (+ `input.spec.ts`) -- delete `parseOptionalDate` and `assertNoNullFields` if no production caller remains, with their spec cases.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append one entry noting that `parseOptionalDate` and `assertNoNullFields` were deleted in 9.4, so the 9.1 AGENTS.md entry now concerns only `parseDate` and `assertNoDuplicates`. Do not edit existing entries.
- [x] `src/shared/api/input-validation.integration.test.ts` -- re-pin the two changed messages to `^Invalid input\.` plus the field name. Keep each test's intent.
- [x] `src/modules/maintenance/maintenance-input-validation.integration.test.ts` -- new.
  - Cover: one GraphQL refusal per matrix row and the surfaces it names; `refused()` asserts prefix and field (leap second: the field only); for update, complete and delete, a fixture window in `scheduled` status, with services, reads back unchanged (row, services, counts); counts unchanged; no maintenance event.
  - `before` asserts all five maintenance event types are registered.
  - Accepting controls: a valid schedule with services persists and emits `maintenance/created`; update (title and dates), complete and delete each succeed and emit their event; update `description: null` reads back NULL; GraphQL duplicate service ids still say "more than once".
  - REST controls (400): schedule with a 201-char title, a date-only start, the leap second; update with `scheduledStartAt: null` and with the leap-second `scheduledEndAt`; `POST /maintenance/not-a-uuid/complete`.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`, in the existing format.

**Acceptance Criteria:**
- Given any matrix row over GraphQL, when sent, then the outcome matches the matrix.
- Given the same invalid input over REST, when sent, then it is still a 400.
- Given the seed's `scheduleMaintenanceCommand` call, when `tsc` runs, then it compiles against the string dates.

## Design Notes

The story's Files line names only the handlers and a test. Resolvers, routes, the seed and `input.ts` change too: a handler can check a date's format only if it receives the request's string, and two helpers lose their last caller.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `input.ts` docblock still describes guards for input that skipped a schema (blind) | low | `input.ts:3-11`; handlers now check the schema first | patch |
| 2 | A test comment describes the old Invalid-Date path (blind) | low | `input-validation.integration.test.ts:180-181` | patch |
| 3 | `before()` never checks the service creates' status (edge) | low | `maintenance-input-validation.integration.test.ts:170-176` | patch |
| 4 | AGENTS.md "older handlers ... move to this" is now wrong: no `assertNoNullFields` caller remains (blind) | low | AGENTS.md:36; fix edits an agent-context file | defer |
| 5 | Sprint status says in-progress during review (blind) | false | Step 5 sets `review` at presentation | reject |
| 6 | The spec is not in the reviewed diff (blind) | false | Withheld from the diff by design; committed with the story | reject |
| 7 | No stored-date read-back after a GraphQL update (blind) | false | The shared handler is covered: `schedule-maintenance.integration.test.ts:195` reads back `scheduled_end_at`; :237-251 refuses an inverted window | reject |
| 8 | "REST agrees" tests sample one REST case each (blind) | low | REST route validation is unchanged by this story; the controls show parity per rule | reject |
| 9 | No GraphQL test that a well-formed unknown id is still 404 (blind) | low | Unchanged path after `assertUuid`; REST 404 pinned at `schedule-maintenance.integration.test.ts:269` | reject |
| 10 | Leap-second refusal lacks the `Invalid input.` prefix (blind) | low | Same as 9.3 triage #6; rare input, fix adds a branch | reject |
| 11 | Payload types restate the request by hand; only dates typed nullable (blind) | low | Follows 9.3's approved payload shape; no caller diverges | reject |
| 12 | REST `description: null` → `""` has no test (blind) | low | Already deferred in this story | reject |
| 13 | End-after-start not re-checked over GraphQL (blind) | low | Shared handler; REST tests :121-129 and :237-251 cover it | reject |
| 14 | A date outside years 1..9999 via offset or year 0000 is a masked 500 (edge) | medium | Pre-existing on both surfaces; same root as the 9.3 deferred entries | defer |
| 15 | The same service UUID in two letter cases passes `assertNoDuplicates` and hits the primary key, an unmapped 23505 (edge) | medium | `maintenance.repository.ts` maps only 23503; Postgres uuid equality ignores case; pre-existing | defer |
| 16 | `urn:uuid:` ids pass `assertUuid` and reach Postgres (edge) | medium | Already deferred from 9.1 (#20); applies to the new maintenance id checks | defer |

## Implementation Notes

- Review patches applied: the `input.ts` docblock now describes the two remaining helpers; a stale test comment reworded; the new suite's setup asserts its service creates.
- `parseOptionalDate` and `assertNoNullFields` deleted with their spec cases; unit count 116 → 111.
- `db:seed` was a no-op (`acme-demo` exists); `tsc` covers its changed call.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass both times.
- `pnpm run test:integration`, twice -- expected: all pass. This machine's database clock steps backwards (deferred-work.md), so a timeline-order failure is re-run, not chased.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds. A no-op if `acme-demo` exists; say so when presenting.
