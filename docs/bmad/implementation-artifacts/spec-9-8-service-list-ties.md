---
title: 'Story 9.8 — Admin service lists settle ties by id'
type: 'bugfix'
created: '2026-10-07'
status: 'done'
baseline_commit: '573bb06d05a930b99bed83abe3583098d1ae2107'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The admin service list orders by `display_order, name` only. Two services tied on both may come back in either order, so they can swap places between requests (audit F-06; AGENTS.md: "A query whose order is part of a response ends at a unique column").

**Approach:** End the list's `ORDER BY` with `id asc`, and prove it with an integration test.

The story also asked for an audit of every other admin query; each one lacking a unique final sort column would become its own story. Planning ran that audit and found none (see Design Notes), so no story is added.

## Boundaries & Constraints

**Always:**
- `display_order asc, name asc` keep their precedence. `id asc` is only the last key.
- The same order applies to every variant of the list: the default, `includeArchived`, `publicOnly`, and GraphQL `services(filter)`. All of them run the one `list` query.

**Never:**
- No change to other queries, the public page, response shapes, or migrations.
- No pagination (Epic 8).
- The test never deletes a service. Services are archived, never hard-deleted, and Story 9.14 will revoke `DELETE` from the runtime role.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Tie | two services with equal `display_order` and `name`, the one with the larger `id` inserted first | listed in `id` order, on every one of several consecutive reads |
| Precedence | services that differ in `display_order`, or in `name` at equal `display_order` | still ordered by `display_order`, then `name` |
| Variants | the same organization listed over REST default, `?includeArchived=true`, `?publicOnly=true`, and GraphQL `services` | the same order on each |

</frozen-after-approval>

## Code Map

- `src/modules/service/database/service.repository.ts:36-42` -- `list`: `order by display_order asc, name asc`. The only admin service list query. `showArchived` and `publicOnly` change only the `where` clause.
- `src/modules/service/database/service-group.repository.ts:30` -- the same fix, made in 9.6: `display_order asc, name asc, id asc`.
- `src/modules/service/list-services.integration.test.ts`
  - Story 2.5's exclusion tests. Nothing in it asserts order today.
  - File-level helpers: `createService(cookie, slug, extra)` and `listSlugs(cookie, query)`.
  - Its `before`/`after` sit inside `describe('Story 2.5')` (:58-79). That `after` also runs `app.close()` and `sql.end()`, so a sibling `describe` would find the app closed.
  - Add the new cases in this file (the story names "its integration test").
- `services` (`db/migrations/*_create_services.sql`) -- `id uuid primary key default gen_random_uuid()`.
  - `name` is not unique; `(org_id, slug)` is, and so is `(id, org_id)` (`services_id_org_uk`, create_incidents migration :8). A plan reading that last index would return `id` order and pass vacuously; the planner has no reason to choose it, which is why the remove-and-fail check stays.
  - The domain mints ids with `randomUUID()`, so creating through the API cannot choose the insertion order.
- `src/modules/incident/incident-reads.integration.test.ts:68-74` -- precedent for inserting a fixture row by SQL inside `withTenantTransaction`.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/service/database/service.repository.ts` -- append `, id asc` to `list`'s `ORDER BY`, with a one-line comment naming the reason.
- [x] `src/modules/service/list-services.integration.test.ts` -- add a `describe` for Story 9.8:
  - Move `buildApp`/`app.ready()` and `app.close()`/`sql.end()` to file-level `before`/`after`. Each `describe` signs up and deletes its own organizations.
  - 9.8 signs up its own organization holding only its four services. Postgres sorts fewer than 7 rows with a stable insertion sort, so the tie keeps scan order. At 7 or more, its quicksort may reorder equal keys and let the test pass without `id asc`. Say so in a comment.
  - The tie pair is inserted by SQL in `withTenantTransaction` for that organization. Its ids are two `randomUUID()`s sorted, with the larger inserted first and given the alphabetically earlier slug. Both have the same `name` and `display_order`. A plan that reads the heap (insertion order) and one that reads the `(org_id, slug)` index then both put the pair in the wrong order without `id asc`. This is deterministic, needs no retry loop, and deletes nothing.
  - Precedence fixtures are created through the API: one service with a lower `display_order` and one with the same `display_order` but an earlier `name`. All names start with a capital letter followed by lowercase letters (e.g. `Alpha`, `Tie`), so collation cannot reorder them.
  - The expected slug order is hard-coded.
  - Read the list over REST (default, `?includeArchived=true`, `?publicOnly=true`) and GraphQL `services { slug }`, and assert the hard-coded order on each.
  - Confirm locally that the tie assertion fails with `id asc` removed, then restore it.

**Acceptance Criteria:**
- Given any matrix row, when the list is read, then the order matches the matrix.
- Given `id asc` is removed, when the new test runs, then it fails. The test makes insertion order and slug order the reverse of `id` order.

## Design Notes

Planning audited every `ORDER BY` in `src/` (`grep -rni "order by" src`). Admin lists:
- Already ending on a unique column: incidents (`started_at desc, id desc`), incident timeline (`created_at, id`), maintenance (`scheduled_start_at desc, id desc`), service groups (`… , id`).
- Ordered by `service_id` within one parent: incident and maintenance affected services. Each is unique per parent by primary key. `maintenance.repository.ts:43` loads several windows' links at once and regroups them per window, so each list is still unique.
- The membership fallback (`organization-context.ts:80`) ends on `id`.
- No admin list lacks an `ORDER BY`.

The public page's lists also end on unique columns, or on keys unique within their parent. So AC 2 of the story yields no new story.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice -- expected: all pass. Re-run a timeline-order failure; it is this machine's clock (deferred-work.md).
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op if `acme-demo` exists.

## Implementation Notes

- The audit found no other admin query lacking a unique final sort column, so AC 2 adds no story.
- Review patches applied: `Alpha` is inserted by SQL with the largest id, so a name-before-id ordering is proven; the comments say insertion order is usually heap order and slug order is the reverse of id order regardless; the file header names Story 9.8.
- Checked by hand: the two 9.8 tests fail both with `id asc` removed and with `display_order, id, name`, and pass with the fix.
- Verified: check clean; unit 111/111 with and without `.env`; integration 276/276 twice; auth schema in sync; `db:seed` a no-op (`acme-demo` exists).

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `Alpha` has a random API id, so a wrong `display_order, id, name` order passes about 1 run in 3; the Precedence row is not proven (blind) | medium | Three rows share `display_order = 1`; only Alpha's id decides whether name-before-id is tested | patch |
| 2 | Heap order is free-space-map placement, not insertion order, so the test's comments overstate the guarantee (gap, edge ×2) | low | A second insert may land on an earlier page; the slug-index order is the reverse of id order regardless. Rewording is a direct correction | patch |
| 3 | The file header still names only Story 2.5 (blind) | low | `list-services.integration.test.ts` JSDoc | patch |
| 4 | `includeArchived` and `publicOnly` reads return the same rows as the default (edge, blind) | low | All variants run the one `list` query and one `ORDER BY`; only `where` differs. Proving it per variant needs extra fixtures | reject |
| 5 | GraphQL is read without a filter, and once (edge, blind) | low | The resolver passes `filter` to the same handler and query; REST covers the repeated reads | reject |
| 6 | The file-level `after` throws if `before` failed (edge) | low | Only after a setup failure that is already reported, as 9.6 #9 | reject |
| 7 | Tie rows rely on the `is_public` default (blind) | low | `is_public boolean not null default true` in the services migration; a changed default would fail loudly on `publicOnly` | reject |
| 8 | Globals used only by Story 2.5 sit at file level (blind) | low | Cosmetic; no reader is misled into a failing test | reject |
| 9 | Deleting the organization cascades a hard delete of services, against "never deletes" (edge) | false | The constraint is about the test issuing `DELETE` on `services`, which 9.14 revokes. Postgres runs foreign-key cascades as the owner of the referencing table, and every integration file already cleans up this way | reject |
| 10 | The spec is missing from the diff, with empty notes and statuses out of step; 9.7 is closed here (blind) | false | The spec is withheld from reviewers by design and committed with the code; step 5 sets review; the owner asked for 9.7's bookkeeping here | reject |
