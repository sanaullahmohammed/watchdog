---
title: 'Story 5.14: Order the public timeline by the same sequence'
type: 'feature'
created: '2026-10-17'
baseline_commit: '65a7b42e881948b3fd2d85d986fe94306445f76f'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The public timeline still orders `incident_updates` by `(created_at, id)`. After a clock step it can disagree with the admin timeline, which story 5.13 moved to `sequence` (Epic 2 D-1).

**Approach:** The public read orders by `sequence`, with the draft-era filter unchanged. A new migration drops `incident_updates_timeline_idx`, which no read uses any more. The stale comments and AGENTS.md lines that still call `(created_at, id)` the order are corrected. That closes D-1.

## Boundaries & Constraints

**Always:**
- The contract is story 5.14's acceptance criteria in epics.md. The rule is DOMAIN, IncidentUpdate (`sequence` is the timeline order) and Public status page ("oldest first, except those recorded with status `draft`").
- **Read.** `public-status.repository.ts` orders the updates query by `sequence asc` only, keeps `and status <> 'draft'`, and never selects `sequence`. The payload, DTO and SDL do not change.
- **Index.** New migration `db/migrations/20261017140000_drop_incident_updates_timeline_idx.sql` drops `incident_updates_timeline_idx`. Down recreates it exactly: `on incident_updates (incident_id, created_at, id)`. `incident_updates_sequence_idx (incident_id, sequence)` serves both reads and the FK.
- **Old migration comments** (comment-only edits, allowed by AGENTS.md): in `20260910180503_create_incident_updates.sql` above the index, and `20260911191653_incident_updates_write_time.sql` lines 2-8, append one sentence each. Above the index: "Stories 5.13 and 5.14 moved both timelines to `sequence`, and `20261017140000_drop_incident_updates_timeline_idx.sql` drops this index." After l.8 of the write-time migration: "Stories 5.13 and 5.14 later moved the order to `sequence`; `created_at` is now for display." Existing text stays. No DDL changes.
- **AGENTS.md.** (a) The append-only bullet: `incident_updates` also grants `watchdog_app` insert per column, leaving out `sequence`, so a migration adding a column there must grant insert on it or inserts naming it fail with 42501; `check_results` already revokes (it has arrived). (b) The `now()`/`clock_timestamp()` pitfall: a column that orders rows written under a lock is an identity column numbered at insert after the lock, as `incident_updates.sequence` is; `clock_timestamp()` is for display and is not monotonic. (c) The WSL clock pitfall: drop the example "most often an incident timeline that shows a later status before `investigating`" and "The lasting fix ... D-1", keep "(Epic 9 retrospective, P2)"; say both incident timelines order by `sequence` (5.13, 5.14), so they no longer depend on the clock.
- **Tracking.** `sprint-status.yaml` D-1 action item becomes `status: done`. The `deferred-work.md` entries that target Story 5.14 are removed.
- New test helpers go in `src/shared/testing/fixtures.ts` (Story Generation Constraint 9).
- **DOMAIN first (owner, 2026-10-17).** Before the code change, `docs/genesis/DOMAIN.md` gets three edits: the mermaid `INCIDENT_UPDATE` entity (~l.547) gains `bigint sequence` after `created_at`; the IncidentUpdate `sequence` row (l.189) appends "; `watchdog_app` is granted insert on every other column, so tenant code cannot choose it"; Public status page (l.1109) reads "oldest first by `sequence`, except those recorded with status `draft`". The 5.13 deferred-work entry for that Genesis edit is removed with the 5.14 entries.
- **Other Genesis entries (owner, 2026-10-17).** ARCHITECTURE 6.1's definer-function count and DOMAIN's public-uptime wording stay deferred, untouched.
- **Spec size (owner, 2026-10-17).** Kept as one story above 1600 tokens: the doc cleanups are only true once the public read moves.

**Never:**
- Touch `src/modules/incident/` or any applied migration's DDL.
- Change `created_at`'s default, or expose `sequence`.
- Edit `docs/genesis` beyond the three DOMAIN edits above.

## I/O & Edge-Case Matrix

Integration tests, new file `src/modules/status-page/public-timeline-order.integration.test.ts`, one organization of its own with one public service.

| Scenario | Input / State | Expected |
|---|---|---|
| Clock steps back | A draft incident inserted directly (`source: monitoring`). A draft-era note inserted directly with `created_at = now() + 2 hours`. Then a confirmation through the API (`investigating`, "We are investigating."). Then two entries inserted directly, in two separate transactions, one after the other: `first` at `now() + 1 hour`, `second` at `now() − 1 hour`. | `GET /status/:slug`: the incident's updates are exactly the confirmation, `first`, `second`. The old order would read `second`, confirmation, `first`. The draft note is absent. |
| Parity | The same incident over GraphQL `publicStatusPage` | The same update ids in the same order |
| Stored | `select status from incident_updates ... order by sequence` | `draft`, `investigating`, `investigating`, `investigating`: the note was stored and left out by status |
| Index (`public-timeline-order`) | `pg_indexes` for `incident_updates` | No `incident_updates_timeline_idx`; `incident_updates_sequence_idx` present |
| Existing order clause | `public-status-payload.integration.test.ts:768` `order by created_at, id` | `order by sequence`; assertion unchanged |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/database/public-status.repository.ts:233-249` -- the updates query; change `order by created_at asc, id asc`. `created_at` stays selected for `createdAt` (l.267).
- `src/modules/incident/database/incident.repository.ts:39-62` -- 5.13's `timeline()`; reference for the order and its comment. Do not edit.
- `db/migrations/20261017130000_incident_updates_sequence.sql` -- the identity, `incident_updates_sequence_idx`, the column grants. Direct inserts as `watchdog_app` may name only `id, org_id, incident_id, status, message, created_by_user_id, created_at`.
- `db/migrations/20260910180503_create_incident_updates.sql:25-28`, `20260911191653_incident_updates_write_time.sql:2-8` -- the comments to correct.
- `src/modules/status-page/public-status-payload.integration.test.ts:403-431` -- the draft-then-confirm fixture pattern (direct `insert into incidents ... 'draft' ... 'monitoring'`, then `post` to `/incidents/:id/transition`); `:92-125` `fetchPage`, `fetchPageOverGraphql`; `:768` the order clause. The new suite copies the local `post` shape (`/api/v1` prefix, `cookie` plus `origin: TEST_ORIGIN`, since Better Auth refuses a cookie POST without Origin) and sends GraphQL through `gqlData` from `src/shared/testing/graphql.ts` with `query ($slug: ID!) { publicStatusPage(orgSlug: $slug) { activeIncidents { id updates { id status message } } } }`.
- `src/modules/status-page/public-uptime.integration.test.ts:30-40` -- `makeOrg` (`signUpWithOrg`) and the `after` teardown at :75-82 that deletes the organization and user, closes the app and ends `sql`. Create the service with `createService(app, cookie, { name })` (public by default). The suite runs no worker pass.
- `src/modules/incident/incident-reads.integration.test.ts:79-117` -- 5.13's clock test: inserts in separate `withTenantTransaction` calls with `now() + ${offset}::interval`.
- `src/shared/testing/fixtures.ts` -- add `insertDraftIncident(orgId, {title, impact}): Promise<string>` (returns the id; `source 'monitoring'`) and `insertIncidentUpdate(orgId, {incidentId, status, message, createdAtOffset})`, where the offset is an interval string such as `'1 hour'` or `'-1 hour'`, applied as `now() + offset::interval`. Each runs in its own `withTenantTransaction`. Existing suites need not move to them.
- `src/shared/db/foreign-table-allowlist.spec.ts:66` -- `incident_updates` already allowed for status-page; no change.
- `AGENTS.md:51,72,73`; `sprint-status.yaml:124-128` (D-1); `deferred-work.md`, under `## From Story 5.13`: remove the four entries whose summaries begin "Story 5.14 moves" (l.241), "AGENTS.md's pitfall" (l.245), "`incident_updates` now grants" (l.257) and "Genesis edit (owner). DOMAIN's mermaid" (l.261). Keep the Epic 4 cursor and Epic 8 backfill entries. No `sprint_plan.py` regeneration; the workflow moves `5-14` itself.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/DOMAIN.md` -- the three approved edits, first
- [x] `db/migrations/20261017140000_drop_incident_updates_timeline_idx.sql` -- drop; down recreates
- [x] `src/modules/status-page/database/public-status.repository.ts` -- order by `sequence`, comment citing D-1 and 5.13
- [x] `src/shared/testing/fixtures.ts` -- the two helpers
- [x] `src/modules/status-page/public-timeline-order.integration.test.ts` -- the matrix rows
- [x] `src/modules/status-page/public-status-payload.integration.test.ts` -- l.768
- [x] the two old migrations -- comments only
- [x] `AGENTS.md` -- lines (a), (b), (c)
- [x] `sprint-status.yaml`, `deferred-work.md` -- D-1 done; remove the 5.14 entries

**Acceptance Criteria:**
- Given `grep -rn "created_at" src/modules/status-page`, then no hit is in an `order by` clause (select-list hits stay).
- Given `dbmate rollback` then `dbmate up` locally, then both succeed and the index is absent afterwards.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row.
- The main session reworded AGENTS.md's append-only sentence ("`incident_updates` and `check_results` do this") and wrapped the two old migration comments to the file's width. Comments and prose only.
- **Mutation checks (main session).** With the public read put back to `order by created_at asc, id asc`, the clock test fails, reading `second`, confirmation, `first`. With the draft filter removed, it fails too. Both edits were reverted.
- **AC 1.** `grep -rn "order by" src/modules/status-page | grep created_at` has no hit.
- **AC 2.** The subagent ran `dbmate up`, `rollback`, `up` against the owner URL; all succeeded, and the index test passes after.
- Review pass 1 led to six patches (B1, B2/E2, B4, B5, E1, E3, E4), sent back to the same implementation subagent. The main session read the changed test and fixtures. B7 was deferred (AGENTS.md edit).
- The review subagents were cut off once by a usage limit and resumed from where they stopped.
- The implementation subagent found the containers stopped mid-run, ran `docker compose up -d`, stopped `api` and `worker` again, and reapplied migrations.
- Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 251 of 251, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 609 of 609, first run. No failures, so no reruns.
  - e2e: 4 scenarios, 53 steps. `auth:schema:check` is in sync.

## Spec Change Log

## Review Triage Log

Spec review (before approval), Sonnet reviewer, verified by the main session.

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | Deferred-work removal said "three entries, l.240-260" but four go, one outside the range | medium | Code Map names the four by summary and line |
| 2 | Sprint-status transition for 5-14 unspecified | false | bmad-build syncs `5-14` itself; noted in Code Map |
| 3 | GraphQL parity not executable; `fetchPageOverGraphql` is local | low | Code Map names `gqlData` and the query |
| 4 | New suite setup and teardown vague (Origin, `/api/v1`, cleanup, helper signatures) | low | Code Map names the pattern, teardown and helper types |
| 5 | Concurrency: say no worker pass | low | Stated; the `pg_indexes` read is safe concurrently |
| 6 | Grep criterion also hits the select list | low | Reworded to `order by` clauses |
| 7 | Old-migration comment wording not given | low | Exact sentences given |
| 8 | AGENTS (c) should name the removed text and keep P2 | low | Done |
| 9 | Empty template sections | false | Template sections, filled later |

Review pass 1. B = blind, E = edge-case. The verification-gap layer reported no gaps.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| B1 | No test compares the public timeline with the admin one, though "the two never disagree" is the story | low | True: each is tested alone. patch (admin ids minus `draft` entries equal the public ids) |
| B2/E2 | GraphQL is checked only against REST, and the REST status is not asserted | low | True. patch (assert 200; GraphQL messages equal `expected`) |
| B3 | The third test's name claims the note is left out, but it checks only stored statuses | false | The first test's exact `deepEqual` on the whole list already proves the note is absent |
| B4 | `createService` is unused setup | low | True. patch (delete) |
| B5 | Helpers duplicate the incident suite's inline insert and type ladders as `string` | low | Duplication is allowed by the Code Map ("existing suites need not move"). Typing: patch (`IncidentStatus`, `IncidentImpact`) |
| B6 | No same-timestamp test on the public read | low | Rejected: the clock test already fails any `created_at`-led order; a tie case adds nothing the read can still get wrong |
| B7 | The reworded AGENTS.md pitfall drops "insert order is not commit order", and its `now()` clause leads nowhere | low | True. defer (fix edits AGENTS.md, an agent-context file) |
| B8 | The old migration's "(created_at, id) is the timeline order" stays present tense | low | Rejected: the frozen rule says existing text stays, and the added line directly below dates it |
| B9 | `drop index if exists` hides an unexpected state | low | Rejected: the repo's other index drop uses the same form (`20261016130000_add_monitors_due_index.sql:9`), and an absent index leaves nothing to do |
| B10 | Sprint status `in-progress` while the story is complete | false | The present step moves it to `review` |
| E1 | `after()` throws a TypeError when `before()` failed before `org` was set | low | True. patch (guard) |
| E3 | `insertDraftIncident` says "the way Epic 5 will write one" but sets no `origin_monitor_id` | low | True for the comment. patch (reword) |
| E4 | `pg_indexes` read by table name with no schema | low | One schema today; patch is a direct correction (`schemaname = current_schema()`) |

## Verification

**Commands** (only postgres and mailpit running):
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside (never while another suite runs) -- pass
- `timeout 900 pnpm run test:integration` -- pass; rerun any failure 2-3 times and report every one
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
