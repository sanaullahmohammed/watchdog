---
title: 'Story 9.14 — The runtime role cannot hard-delete a service'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: '2f04fb9070a44255599289934e208216419228db'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** DOMAIN says services are archived, never hard-deleted ("v1 has no hard service delete"). But `watchdog_app` still holds `DELETE` on `services`, granted by the original grant migration and by its default privileges. So anything holding a tenant transaction can delete a service with raw SQL, and the rule is only remembered, not enforced (audit F-17).

**Approach:** A new migration revokes `DELETE` on `services` from `watchdog_app`, as `create_incident_updates.sql` already does for `incident_updates`. An integration test proves the refusal, the grant, and that archive, restore and organization cleanup still work.

## Boundaries & Constraints

**Always:**
- A new dbmate migration in `db/migrations/`, with `-- migrate:up` running `revoke delete on services from watchdog_app;` and a comment giving the reason.
  - Its `-- migrate:down` re-grants `delete`.
  - Its timestamp is later than every existing migration.
- Deleting an organization still removes its services. Postgres runs a foreign key's `on delete cascade` as the owner of the referencing table, not the caller (`ri_triggers.c`, `SECURITY_LOCAL_USERID_CHANGE`), and every integration file cleans up this way.
  - `incident_updates` already proves it: `watchdog_app` holds no `DELETE` there, yet organization cleanup removes its rows.
  - Every foreign key on the path is `CASCADE` or `SET NULL`; none is `RESTRICT`.

**Never:**
- No edit to `20260910053718_grant_watchdog_app.sql` or any other applied migration.
- No change to `SELECT`, `INSERT` or `UPDATE` on `services`, to the default privileges for future tables, or to any other table.
- No application code change; nothing in `src/` issues `delete from services`.

## I/O & Edge-Case Matrix

| Scenario | Action, as `watchdog_app` | Expected |
|---|---|---|
| Raw delete | `delete from services where id = …` inside `withTenantTransaction` | rejects with `permission denied for table services`; the row is still there |
| Grant | `information_schema.role_table_grants` for `services`, grantee `watchdog_app` | exactly `INSERT`, `SELECT`, `UPDATE`; today it is those plus `DELETE` |
| Archive and restore | `POST /api/v1/services/:id/archive`, then `/restore` | both answer 200 `{ changed: true }`; the service is archived, then live again |
| Organization cleanup | `delete from "organization" where "id" = …` for an organization with a service | succeeds; the service, counted 1 before, is gone |

</frozen-after-approval>

## Code Map

- `db/migrations/20260910053718_grant_watchdog_app.sql:11-18`
  - It grants `select, insert, update, delete` on all tables.
  - It sets `alter default privileges … grant select, insert, update, delete on tables to watchdog_app`, so `services` got `DELETE` at creation.
  - Do not edit it.
- `db/migrations/20260910180503_create_incident_updates.sql:43-48` -- the precedent: `revoke update, delete on incident_updates from watchdog_app;` and why.
- `db/migrations/20260911191653_incident_updates_write_time.sql` -- the latest migration; it shows the `-- migrate:up` / `-- migrate:down` shape.
- `src/modules/incident/incident-updates.integration.test.ts:140-195` -- the test precedent:
  - a raw write inside `withTenantTransaction` asserting `/permission denied for table incident_updates/` and that nothing changed;
  - a query of `information_schema.role_table_grants`.
- Services link to `organization` with `on delete cascade` (`20260910170120_create_services.sql:8`). Rows referencing services, such as incident impacts and maintenance links, cascade from services in turn.
- `src/shared/testing/fixtures.ts` -- `createService(app, cookie)`. `src/shared/testing/tenant.ts` -- `signUpWithOrg`.
- The local database must be migrated (`pnpm run db:migrate`, owner credentials from `DBMATE_DATABASE_URL`) before the integration suite sees the change. CI's `database` job migrates first.
- No script rolls back, and a bare `dbmate` uses `DATABASE_URL`, which is `watchdog_app`. As that role, the down migration's `grant` only warns, and the version row is still removed, so a bare `dbmate down` appears to succeed while the revoke stays in place. A bare `dbmate up` fails the same way: the revoke only warns, and the version row is written anyway. Migrate only through `pnpm run db:migrate`, and roll back only with `-e DBMATE_DATABASE_URL`. The grant case catches an apply that did nothing.
- No schema dump is tracked, so nothing needs regenerating. dbmate writes `db/schema.sql` whenever `pg_dump` is on `PATH`. If that file appears, do not commit it.

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/<UTC timestamp>_revoke_service_delete.sql` (new) -- the revoke, its comment, and the down re-grant. Apply it locally with `pnpm run db:migrate`.
- [x] `src/modules/service/service-delete-privilege.integration.test.ts` (new)
  - One case per matrix row, in one organization of its own, plus a second organization for the cleanup row.
  - The cleanup row creates a service through the API in the second organization and deletes that organization.
  - It counts that service's id inside a tenant transaction for that organization's id: 1 before the delete and 0 after. The row's `org_id` matches the GUC, so RLS would show it if it still existed. `withTenantTransaction` checks only the id's format, so it accepts a deleted organization's id.
  - No owner connection is needed.
  - Uses the shared fixtures. The `after` runs `delete from "organization" where "id" in (<both ids>)`, which is idempotent, then deletes both users and closes the app and `sql`.
  - The grant case filters `table_schema = 'public'` and `table_name = 'services'`, and compares the sorted privilege list with `['INSERT', 'SELECT', 'UPDATE']`.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append two entries and any review finding routed `defer`:
  - DOMAIN's "v1 has no hard service delete" could note that a migration enforces it, as its `check_results` entry does.
  - `watchdog_app` can write dbmate's `schema_migrations` table.

**Acceptance Criteria:**
- Given any matrix row, when exercised, then the outcome matches.
- Given the migration rolled back locally with `pnpm exec dbmate -e DBMATE_DATABASE_URL down`, when the new test file runs, then the raw-delete and grant cases fail. Check this once by hand, then run `pnpm run db:migrate`.

## Verification

**Commands:**
- `pnpm run db:migrate` -- expected: applies the new migration.
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice -- expected: all pass, every file's organization cleanup included. Re-run a timeline-order failure; it is this machine's clock.
- `pnpm run test:e2e` -- expected: all scenarios pass. Its hooks delete organizations too.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op.

## Implementation Notes

- Migration `20261008120000_revoke_service_delete.sql`: up revokes `DELETE` on `services` from `watchdog_app`; down re-grants it. It is applied locally through `pnpm run db:migrate`.
- Review patches applied: the migration comment explains the revoke is one-time and names its test guard (a comment-only edit); the test drains the event bus before cleanup; the `schema_migrations` deferred entry names its risk and fix.
- Checked by hand: rolled back with `pnpm exec dbmate -e DBMATE_DATABASE_URL down`, the raw-delete and grant cases fail (2 of 4). Re-migrated, 4 of 4 pass. No `db/schema.sql` appeared.
- The implementer's first full integration run had one uncaptured failure. Five later runs, three before review and two after, passed 344/344.
- Verified: check clean; unit 135/135 with and without `.env`; integration 344/344 twice; e2e 3/3; auth schema in sync; `db:seed` a no-op.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The migration comment does not say the revoke is one-time, or that a later blanket grant would give `DELETE` back (blind) | low | The `create_incident_updates.sql` precedent says so; comment-only edits to an applied migration are allowed | patch |
| 2 | `after()` deletes the organizations while archive and restore handlers may still run (edge) | low | Other suites drain the bus first | patch |
| 3 | The `schema_migrations` deferred entry names no risk or fix (blind) | low | Written in this story; the risk is a migration recorded as applied that never ran | patch |
| 4 | The cleanup case covers only the first cascade step: no group, incident or maintenance link (blind) | low | Every integration file already deletes organizations whose services carry those links, and the suite passed 344/344 three times with the revoke applied | reject |
| 5 | The grant view misses `DELETE` reaching the role through `PUBLIC` or membership; check `has_table_privilege` (blind, edge) | low | The raw-delete case tests the effective privilege; `watchdog_app` is `NOINHERIT` | reject |
| 6 | The permission-denied regex depends on the server's message locale; `archivedAt` and `after()` throw `TypeError` on a missing row or failed setup (edge, blind) | low | It follows the `incident_updates` precedent, and the locale is English in CI and Compose; the rest fires only after an already-reported failure | reject |
| 7 | The archive-and-restore case repeats the Story 2.4 suite (blind) | low | The spec requires it here, to prove archive is an `UPDATE` the revoke leaves alone | reject |
| 8 | AGENTS.md still states "never hard-deleted" as a convention, not as enforced (blind) | low | Agent-context file | defer |
| 9 | Statuses disagree; 9.13 closed in this diff (blind) | false | Step 5 sets review; the owner asked for 9.13's bookkeeping here | reject |
