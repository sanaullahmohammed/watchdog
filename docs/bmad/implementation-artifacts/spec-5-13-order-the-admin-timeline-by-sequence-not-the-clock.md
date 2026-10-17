---
title: 'Story 5.13: Order the admin timeline by sequence, not the clock'
type: 'feature'
created: '2026-10-17'
baseline_commit: 'ec951d960b29b61aaebad3ba3c242663cf678506'
status: 'done'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The admin timeline orders `incident_updates` by `(created_at, id)`. `created_at` is `clock_timestamp()`, and the clock can step back, so a later entry can sort before an earlier one (Epic 2 D-1). Story 5.15 will soon have monitors writing into drafts.

**Approach:** One migration adds a `sequence` column that Postgres fills itself at insert. Existing rows are numbered in their current `(created_at, id)` order. The incident repository's timeline read orders by `sequence`. The incident suites stop using `created_at` for order.

## Boundaries & Constraints

**Always:**
- The contract is story 5.13's acceptance criteria in epics.md. The rule is DOMAIN, IncidentUpdate.
- **DOMAIN first (owner, 2026-10-17).** Before the migration, DOMAIN's IncidentUpdate table gains the row `sequence | bigint | Generated always as identity; the timeline order, assigned at insert under the incident's row lock, so it follows the lock rather than the clock (Epic 2 D-1)`, and `created_at`'s note becomes "when the entry was written, for display; not the order, because the clock can step back". Nothing else in `docs/genesis` changes.
- **Column.** `sequence bigint not null generated always as identity`, with the identity's default `cache 1`, which keeps numbers in insert order across connections. A unique index on `(incident_id, sequence)` serves the read and enforces the order's uniqueness.
- **Backfill.** Inside the migration, existing rows get `row_number() over (order by created_at, id)`. Then the identity is attached, and its sequence is set past the maximum so new rows continue from there. The migration runs as the owner. That role is a superuser in Compose and CI, so `FORCE`d RLS does not hide rows from the backfill. A non-bypass owner would leave rows null, and `set not null` would then fail the migration loudly.
- **Grants (owner, 2026-10-17, after review pass 1).** `generated always` alone refuses only a plain explicit value. Any role with table `INSERT` can still pass `overriding system value`. So the migration revokes table-level `insert` on `incident_updates` from `watchdog_app` and grants `insert (id, org_id, incident_id, status, message, created_by_user_id, created_at)`. That is every column except `sequence`, so `watchdog_app` cannot choose a value. A future column on this table needs its own insert grant in its migration. The existing `revoke update, delete ... from watchdog_app` stays in force. The down migration restores table-level `insert`.
- **Read.** `incidentRepository.timeline` orders by `sequence asc` only. The value is never selected into the entity, the DTO, or the SDL, so REST and GraphQL shapes do not change.
- **Lock.** Transitions lock the incident `for no key update`, and posted updates lock it `for share`, before they insert. `nextval` is taken at insert, after the lock is held, so a transition's entry is numbered after every entry it waited for. Two posts that run at the same time do not block each other, and they are numbered in insert order.
- Test SQL in `src/modules/incident/` that orders `incident_updates` uses `order by sequence`.

**Never:**
- Touch `src/modules/status-page/` or its `incident_updates` order. That is story 5.14.
- Drop `incident_updates_timeline_idx`, because the public read still uses it until 5.14.
- Expose `sequence` in a response, or edit an applied migration.
- Change `created_at`'s default, or edit `docs/genesis` beyond the IncidentUpdate edit above.

## I/O & Edge-Case Matrix

These are integration tests in `src/modules/incident/`. Each names its file.

| Scenario | Input / State | Expected |
|---|---|---|
| Clock steps back (`incident-reads`) | A declared incident. Two entries are inserted directly, in two separate transactions, one after the other. The first has `created_at = now() + 1 hour`, the second `now() − 1 hour`. | REST timeline: the declaration, then the first entry, then the second. GraphQL agrees. |
| Tie (`incident-reads`, rewrite of l.80-117) | Three entries in three `insert` statements inside one transaction, sharing one `created_at`, with explicit ids chosen so the `values` order is the reverse of their uuid sort order | They read in insert order (messages `one`, `two`, `three`), twice in a row identically. The old `(created_at, id)` order would always read them reversed. |
| Identity (`incident-updates`) | `information_schema.columns` and `pg_indexes` for `incident_updates` | `sequence` has `is_identity = 'YES'`, `identity_generation = 'ALWAYS'`, `is_nullable = 'NO'`. A unique index's definition covers exactly `(incident_id, sequence)`, so an index on `sequence` alone fails. `pg_sequences.cache_size` for its sequence is 1. |
| Explicit value refused (`incident-updates`) | Through `withTenantTransaction` (so as `watchdog_app`), an insert that names `sequence` | It errors with code `428C9`. |
| Override refused (`incident-updates`) | As above, with `overriding system value` and `sequence = -5` | It errors with code `42501`. |
| Grants (`incident-updates`, existing "has no update or delete privilege" test) | `information_schema.role_table_grants` and `column_privileges` for `watchdog_app` | Table level: `SELECT` held, and none of `INSERT`, `UPDATE`, `DELETE`. Column-level `INSERT` covers exactly the seven named columns. |
| Lock beats clock (`incident-concurrency`, the staged "posted update waits for an in-flight transition" test) | The held transaction also inserts an entry (message `held`) with `created_at = now() + 1 hour` before it releases | The admin REST timeline's last two messages are `held`, then the posted update. |
| Update still refused (`incident-updates`) | The existing update and delete behaviour tests | Unchanged, and they pass. |
| Suite order (`incident-updates`, `incident-lifecycle`, `incident-concurrency`) | Their `order by created_at, id` | They read `order by sequence`, and their assertions are unchanged. |

</frozen-after-approval>

## Code Map

- `db/migrations/20260910180503_create_incident_updates.sql` -- reference only. It holds the policies, the revoke, and `incident_updates_timeline_idx (incident_id, created_at, id)`.
- `db/migrations/20260910053718_grant_watchdog_app.sql:14-21` -- default privileges gave `watchdog_app` table `insert`, which this migration narrows. `20261008120000_revoke_service_delete.sql` is the pattern for a one-table privilege migration.
- New `db/migrations/20261017130000_incident_updates_sequence.sql`. It sorts after the latest file, `20261017120000_create_uptime_rollups.sql`. Use the `-- migrate:up` / `-- migrate:down` format.
- `src/modules/incident/database/incident.repository.ts:39-62` -- `timeline()`. Change the order and the comment above it. `appendUpdate` (l.174-193) does not change.
- `src/modules/incident/domain/incident-timeline.ts` -- message wording only, with no sort. The epic lists it, but nothing changes there.
- `src/modules/incident/incident-reads.integration.test.ts:80-117` holds the tie test. Its l.142 is the REST/GraphQL parity pattern.
- `incident-updates.integration.test.ts:92,130`, `incident-lifecycle.integration.test.ts:73`, `incident-concurrency.integration.test.ts:67` -- the order clauses to change. `incident-updates.integration.test.ts:142-201` holds the revoke assertions; l.181-201 asserts table-level `INSERT` and must change to the Grants row. Every direct insert in the incident suites names only granted columns. `incident-concurrency.integration.test.ts:197-260` is the staged test.
- Do not touch: `src/modules/status-page/database/public-status.repository.ts:243-249`, `status-page/public-status-payload.integration.test.ts:768`.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/DOMAIN.md` -- IncidentUpdate: add the `sequence` row after `created_at`, and replace the whole `created_at` notes cell (l.188). Done in pass 1 and kept.
- [x] `db/migrations/20261017130000_incident_updates_sequence.sql` -- column, backfill, identity, setval, unique index, the insert grants. Comment the cache, and that the migration holds `ACCESS EXCLUSIVE` while it rewrites every row. Down: restore table `insert`, then `drop column if exists sequence`.
- [x] `src/modules/incident/database/incident.repository.ts` -- order by `sequence`
- [x] `src/modules/incident/incident-reads.integration.test.ts` -- the Clock and Tie rows
- [x] `src/modules/incident/incident-updates.integration.test.ts` -- the Identity, Explicit, Override and Grants rows, plus the order clauses
- [x] `incident-lifecycle.integration.test.ts` -- the order clause
- [x] `incident-concurrency.integration.test.ts` -- the order clause, and the Lock beats clock row
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- 5.14 drops `incident_updates_timeline_idx`. Done in pass 1 and kept. The main session adds review pass 1's defers.

**Acceptance Criteria:**
- Given the 119 rows in the local database before migrating, when `dbmate up` runs, then ordering them by `sequence` gives the same ids as `(created_at, id)`. The check is run by hand and recorded in Implementation Notes, because CI migrates an empty table.
- Given `grep -n "created_at" src/modules/incident/*.integration.test.ts`, then no hit is an order clause.

## Implementation Notes

- A Sonnet subagent implemented the spec. The main session read the whole diff against every task and matrix row.
- **Backfill check (AC 1).** The main session saved the 119 local ids in `(created_at, id)` order before the subagent migrated. Ordered by `sequence` afterwards, the same 119 ids come back in the same order. A `dbmate rollback`, then `up`, ran on the same rows afterwards: 119 distinct non-null values, and 0 rows where `sequence` order differs from `(created_at, id)` order. That proves the down migration works too.
- **AC 2.** `grep -n created_at src/modules/incident/*.integration.test.ts` has no order clause. The remaining hits are inserts that set `created_at` on purpose.
- The main session added comments to the migration, matching the other migrations. Comments only, no DDL change.
- The DOMAIN `created_at` cell no longer names its `clock_timestamp()` default. The default itself is unchanged, and the new wording is the owner-approved text.
- The notes above describe pass 1. Review pass 1 found an intent gap (the Grants row of its triage log). The source and migration changes were reverted and the local migration rolled back. DOMAIN and deferred-work were kept. Pass 1's source diff is kept outside the repo for reference.
- **Pass 2.** A fresh Sonnet subagent re-implemented the amended spec. The main session read the whole code diff against every task and matrix row.
- **Backfill check, pass 2 (AC 1).** The 119 local ids were saved again in `(created_at, id)` order after the rollback. Ordered by `sequence` after the subagent migrated, the same ids come back in the same order: 119 distinct values, max 119.
- **Continuation check.** As `watchdog_app`, in a rolled-back transaction, an entry was appended to an incident whose entries predate the migration, with `created_at` ten years in the past. The incident's timeline by `sequence` lists it last. This is the hand check for B9/V1.
- The main session replaced the Tie test's fixed ids with fresh random ids sorted in reverse. Fixed ids would collide with rows a crashed run left behind.
- Review pass 2 led to six patches (E2, B2/E1, B3, B4, B7, B11), sent back to the same implementation subagent. The main session read the changes and reflowed one comment. The migration was rolled back and reapplied, and the backfill order still matched the saved 119 ids.
- Final verification by the main session, 2026-10-17, with only postgres and mailpit running:
  - `pnpm run check` is clean (11 old warnings).
  - Unit tests: 251 of 251, with and without `.env`.
  - `timeout 900 pnpm run test:integration`: 604 of 604. An earlier pass-2 run failed 7 files at load with "env must have required property 'DATABASE_URL'". The main session had moved `.env` aside for the no-`.env` unit run while that suite was still running. The next run, alone, passed 604 of 604, and so did this one. No test failed on its own merits.
  - e2e: 4 scenarios, 53 steps.
  - `auth:schema:check` is in sync.
  - No api or worker container was left running.

## Design Notes

Sketch:

```sql
alter table incident_updates add column sequence bigint;
update incident_updates u set sequence = o.n
from (select id, row_number() over (order by created_at, id) n from incident_updates) o
where u.id = o.id;
alter table incident_updates alter column sequence set not null;
alter table incident_updates alter column sequence add generated always as identity;
select setval(pg_get_serial_sequence('incident_updates', 'sequence'),
              coalesce(max(sequence), 0) + 1, false) from incident_updates;
create unique index incident_updates_sequence_idx on incident_updates (incident_id, sequence);
revoke insert on incident_updates from watchdog_app;
grant insert (id, org_id, incident_id, status, message, created_by_user_id, created_at)
  on incident_updates to watchdog_app;
```

## Spec Change Log

- **Review pass 1, intent gap (owner, 2026-10-17).** Trigger: `overriding system value` let `watchdog_app` set `sequence` (E1/B1). Amended in the frozen block: the Column and Grants bullets. Added rows: Override refused, Grants, and Lock beats clock (B2). Tie now uses three inserts (B4). Identity checks `cache_size` (B7). Avoids: a timeline that tenant code can reorder while the spec says it cannot. KEEP: the Tie test's explicit reverse-sorted ids and assertion on messages; the Clock test's REST plus GraphQL check by id; the identity test's index regex on exactly `(incident_id, sequence)`; the migration's explanatory comments; `drop column if exists`.

## Verification

**Commands** (only postgres and mailpit running):
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass. Rerun any failure 2–3 times and report every one.
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass

## Review Triage Log

Spec review (before approval), Sonnet reviewer, verified by the main session.

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | Random ids in the Tie row let `(created_at, id)` pass about 1 run in 6 | medium | Explicit ids set in reverse of `values` order; asserted on messages |
| 2 | The Clock row separates sequence from `created_at` order | false | Old order reads entry 2, declaration, entry 1. The row only needed "one after the other" stated |
| 3 | Migration sketch, identity on a populated column, `setval`, `FORCE` RLS | false | Confirmed on a temp table (also by the main session). No `db/schema.sql` exists. `drop column if exists` adopted |
| 4 | Every timeline writer locks before insert | false | Transition `for no key update`, post `for share`, and create inserts the incident in the same transaction |
| 5 | Code Map misses an order clause | false | The four listed are the only ones. No cucumber or seed writes `incident_updates` |
| 6 | DOMAIN task should replace the whole `created_at` cell | low | Task names `DOMAIN.md:188` |
| 7 | The Identity and Explicit rows are vague | low | Catalogue columns, exact index columns, and the role are named |

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| E1/E2/E4/E6/B1 | `GENERATED ALWAYS` does not stop `watchdog_app`: `overriding system value` sets any `sequence`, so tenant code can put an entry before the declaration, or take a number a later insert collides with. The 428C9 test never tries the override | medium | Confirmed as `watchdog_app`: an override insert with `-5` succeeded (rolled back). The frozen block claims "cannot choose a value" and also "never grants anything". A column-level `insert` grant that leaves out `sequence` refuses the override (42501, tried and rolled back), but that is a grant. intent_gap |
| E3/B3 | Concurrent posts (`for share`) can commit out of `sequence` order, so a reader can see N+1 before N. Epic 4's notification cursor reads by stamp, and a `sequence` cursor would still need an overlap | low | True and stated in the Lock rule. It holds equally for `created_at` today, so it predates this story. defer (Epic 4) |
| E5 | The rewrite dropped the "declaration opens the timeline" assertion | false | The Clock test asserts length 3 and that entries 2-3 are `first`, `second`, so entry 1 is the declaration |
| B2 | No concurrency test backs "follows the lock" | low | The staged test in `incident-concurrency` holds the lock but writes no entry. patch (the held transaction appends an entry with `created_at` one hour ahead; the admin read must still list the post after it) |
| B4 | The Tie test relies on identity order within one multi-row `values` | low | Not a documented guarantee. patch (three inserts, one transaction) |
| B5 | Sprint status `in-progress` versus spec `in-review` | false | The present step moves sprint status to `review` |
| B6 | AGENTS.md l.72 (`clock_timestamp()` for lock order) and two old migration comments still call `(created_at, id)` the order | low | AGENTS.md is agent context, and the public read still uses that order until 5.14. defer (5.14) |
| B7 | Order across sessions needs the identity's `CACHE 1`; nothing pins it | low | Confirmed `cache_size = 1` (the default). patch (migration comment; identity test asserts `cache_size = 1`) |
| B8 | Verification results are not recorded in the spec | low | rejected (the fix edits this spec; results are recorded at presentation) |
| B9/V1 | Backfill and `setval` run only against an empty table in CI | medium | V1 pre-verified. Local `last_value` 267 is above `max(sequence)` 119. defer (no pattern for tests from pre-migration data). Before merge, post to a pre-existing incident and record that it reads last |
| B10 | The migration holds `ACCESS EXCLUSIVE` while it rewrites every row | low | patch (one comment line) |
| B11 | The D-1 action item stays `open` | false | Only the admin half is done; it closes with 5.14 |

Review pass 2 (after the intent-gap loopback). B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1 | Backfill, `setval` and down step never run against existing rows in CI | medium | carried: pass 1 B9/V1, deferred (Epic 8). Pass 2's hand checks are in Implementation Notes |
| E2 | Default privileges give `watchdog_app` `USAGE, SELECT` on the identity's sequence: tenant code can read the global `last_value` and burn numbers | low | Confirmed as `watchdog_app` with no tenant set: `last_value` 648. Revoking both still lets inserts number themselves (tried, rolled back). patch (revoke; grants test asserts both privileges are absent) |
| B2/E1 | The `held` entry is inserted before the post is sent, so arrival order alone passes the lock test | low | True: insert precedes `signalLocked()`. patch (insert `held` after the post is blocked, before release) |
| B3 | The grants test's fixed column list cannot catch a new column without its insert grant | low | True. patch (also compare with `information_schema.columns` minus `sequence`) |
| B4 | `42501` is also an RLS violation's code | low | True. patch (also match "permission denied for table incident_updates") |
| B7 | `const [seq]` throws a TypeError on no row; `split_part` naming is fragile | low | patch (`pg_sequence` by `regclass`, row asserted first) |
| B11 | `migrate:down` leaves column-level insert grants behind | low | True, harmless. patch (revoke them in down) |
| B1 | The backfill needs an owner that bypasses `FORCE`d RLS; ARCHITECTURE does not require the owner to be a superuser | low | rejected: the frozen Backfill rule accepts this and names the loud failure (`set not null`). No data is corrupted. Raised with the owner at presentation |
| B5 | AGENTS.md has no pitfall for column-level insert grants, and its append-only bullet no longer says how `incident_updates` is protected | low | defer (agent-context file; 5.14 with the other AGENTS.md lines) |
| B6 | DOMAIN's mermaid `INCIDENT_UPDATE` lacks `sequence`, and the IncidentUpdate row does not say insert is granted per column | low | defer (Genesis edit, owner; the approved scope was the table row only) |
| B8 | Admin and public timelines disagree after a clock step until 5.14 | low | rejected: that is the planned split, and 5.14 is next |
| B9 | The two 5.14 deferred entries overlap | low | rejected: cosmetic; deferred entries are not edited after writing |
| B10 | Spec front matter and Verification carry no results | low | rejected: the fix edits this spec; results are recorded at presentation |
