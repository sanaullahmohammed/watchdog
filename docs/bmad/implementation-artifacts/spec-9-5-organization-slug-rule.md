---
title: 'Story 9.5 — One slug rule for organizations, at creation and lookup'
type: 'bugfix'
created: '2026-10-07'
status: 'done'
baseline_commit: 'b28342609b932ab758e5156afd25b24877b3f655'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Better Auth accepts any non-empty organization slug: uppercase, spaces, a leading hyphen, 500 characters. The public lookup applies WatchDog's slug rule and answers 404 for anything outside it. So an organization can be created, or renamed, whose public page can never answer (audit F-05).

**Approach:** Better Auth's organization hooks (`beforeCreateOrganization`, `beforeUpdateOrganization`) refuse a slug outside the rule with a 400, by calling `isSlug` from `src/shared/domain/slug.ts`, the same function `resolveOrganizationBySlug` already calls.

Existing organizations keep their slugs. DOMAIN.md asks this story to record how many break the rule: the only database available, the local one, holds 2 organizations and 0 outside the rule. One outside it would show the uniform 404.

## Boundaries & Constraints

**Always:**
- One rule, one function: the hooks call `isSlug`. No second regex or length check.
- Refuse with Better Auth's `APIError('BAD_REQUEST', { code: 'INVALID_ORGANIZATION_SLUG', message })`, the message stating the rule, so the client gets a 400 and no `"organization"` row is written or changed. Better Auth also answers 400 for a taken slug and a schema failure, so tests assert the code, not only the status.
- An update that sends no slug is not checked. An update that sends a slug is checked, even when the slug is unchanged; that case is deliberately left untested, since no organization outside the rule exists to send its own slug back.

**Never:**
- No change to `resolveOrganizationBySlug`, the public route, `slug.ts`'s rule, any migration, or `db/better-auth-schema.sql`.
- No normalising, such as lowercasing, of a slug the caller sent: refuse it.
- No migration or rewrite of existing slugs.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Uppercase | create with `Acme-<tag>` | 400 `INVALID_ORGANIZATION_SLUG`; no row |
| Space, underscore | `acme <tag>`, `acme_<tag>` | same |
| Hyphen at an edge or doubled | `-<tag>`, `<tag>-`, `a--<tag>` | same |
| Too long | `SLUG_MAX_LENGTH + 1` characters | same |
| One character | a 1-character slug not yet taken | 200; `GET /status/<slug>` answers 200 |
| At the limit | exactly `SLUG_MAX_LENGTH` | 200; page answers 200 |
| Hyphen runs | `a-b-<tag>` | 200; page answers 200 |
| Rename outside | update `{ slug: "Bad <tag>" }` | 400 `INVALID_ORGANIZATION_SLUG`; slug unchanged |
| Rename inside | update to another valid slug | 200; the new slug's page answers 200 |
| No slug in update | update `{ name }` only | 200; slug unchanged |

</frozen-after-approval>

## Code Map

- `src/shared/domain/slug.ts` -- `isSlug(value)`, `SLUG_PATTERN`, `SLUG_MAX_LENGTH`. Already the single rule. Do not edit.
- `src/modules/status-page/queries/resolve-organization-by-slug/resolve-organization-by-slug.handler.ts:39` -- already calls `isSlug`. Not edited.
- `src/server/auth/auth.ts:35-45`
  - The plugin is configured as `organization({ teams: { enabled: true } })`, with no hooks yet.
  - Import by relative path (`../../shared/domain/slug`): the Better Auth CLI loads this file standalone and cannot resolve `@/*` (comment at :15-18).
- Better Auth 1.7.3:
  - Hook types: `node_modules/better-auth/dist/plugins/organization/types.d.mts:320-362`.
  - Call sites: `routes/crud-org.mjs:64` (create) and :217 (update).
  - Create's `organization` carries the body, with `slug`. Update's `organization` is `ctx.body.data`, a partial, so check `slug` only when it is a string.
  - `APIError` is exported from `better-auth/api`.
- `src/server/auth/auth.integration.test.ts` -- the story's test file.
  - It builds `buildApp({ logger: false })`, sends state changes with `headers: { cookie, origin: ORIGIN }`, and deletes its organizations and user in `after`.
- `src/shared/testing/tenant.ts:40` -- `signUpWithOrg(app, label)` creates an organization with `slug: label`. Every existing test label is lowercase-hex, inside the rule.
- Update endpoint: `POST /api/auth/organization/update`, body `{ data: { slug?, name? }, organizationId }`. The owner may call it.
- Public page: `GET /status/:orgSlug`, unprefixed. A fresh organization answers 200 (`public-status-page.integration.test.ts:106`).
- `db/seeds/seed.ts:31` -- slug `acme-demo`, inside the rule. `auth.api.createOrganization` runs the hook too.
- `src/modules/status-page/public-status-page.integration.test.ts:36-44,84-91` -- creates `overLimit` (`SLUG_MAX_LENGTH + 1`) and `offRule` (`<TAG>_OFF`) organizations through `POST /api/auth/organization/create` and asserts 200. The hooks will refuse both and break that suite. They stand for organizations created before the hooks, and their 404 assertions (:150-151, :218-219) are the evidence that such an organization shows the uniform miss. The story's Files line does not list this file.
- `src/shared/db/tenant-transaction.integration.test.ts:35-37` -- the direct `insert into "organization" ("id", "name", "slug", "createdAt")` pattern, with a Better Auth-shaped id.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/auth/auth.ts` -- add `organizationHooks.beforeCreateOrganization` and `beforeUpdateOrganization` to the organization plugin.
  - Each throws `APIError('BAD_REQUEST', { message })` when `isSlug` refuses the sent slug.
  - The message names the rule: lowercase letters and digits in hyphen-separated runs, at most 120 characters.
  - Both are `async`. Neither returns `data`: on create a returned `data` is merged over the whole body (`crud-org.mjs:69`), which would put `userId` back into the insert.
  - One short comment points at DOMAIN.md's rule.
- [x] `src/server/auth/auth.integration.test.ts` -- a new `describe` covering every matrix row through Better Auth over HTTP.
  - Refusals assert a 400 with code `INVALID_ORGANIZATION_SLUG`, and that no `"organization"` row has the slug: query by slug, double-quoting the identifiers.
  - Lengths come from `SLUG_MAX_LENGTH`, imported from `slug.ts`, never a literal 120 or 121.
  - Accepted slugs assert 200 and `GET /status/<slug>` 200.
  - The 1-character slug is chosen from `a-z0-9` among those no row holds yet. If the create answers `ORGANIZATION_ALREADY_EXISTS`, try the next candidate. If all 36 are taken, fail with a message saying so.
  - Every organization and user the describe creates is deleted in its own `after`.
- [x] `src/modules/status-page/public-status-page.integration.test.ts` -- create the `overLimit` and `offRule` organizations by direct insert (the tenant-transaction pattern) instead of through Better Auth, and delete them in the file's cleanup. Comment that they stand for organizations created before the hooks. Keep every assertion about them unchanged.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`, in the existing format.

**Acceptance Criteria:**
- Given any matrix row, when sent, then the outcome matches the matrix.
- Given the hooks and the lookup, when read, then both call `isSlug` from `src/shared/domain/slug.ts`, and nothing else in `src/` restates the pattern.
- Given `pnpm run auth:schema:check`, when run, then it reports in sync: the hooks change no schema.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `atLimit`, inside the rule, is now inserted directly, contrary to the spec, so that suite no longer proves a Better Auth-created 120-character organization is served; the comment says all three are refused (blind, edge) | low | `public-status-page.integration.test.ts` loop over `Object.values(edge)` | patch |
| 2 | The `offRule` comment still says Better Auth accepts it (blind) | low | `public-status-page.integration.test.ts:37` | patch |
| 3 | `POST /organization/check-slug` still reports an off-rule slug as available (gap, blind, edge) | medium | `crud-org.mjs:151-159` checks only existence; no WatchDog caller; DOMAIN.md:39 covers create and change only | defer |
| 4 | A pre-hook organization resending its unchanged off-rule slug is refused (blind, edge) | low | Decided in the approved spec; no such organization exists | reject |
| 5 | An off-rule slug that already exists gets ALREADY_EXISTS rather than INVALID_ORGANIZATION_SLUG (edge) | low | Only reachable for pre-hook organizations, of which none exist; refused either way | reject |
| 6 | Refusal tests leak a row if the hook regresses (blind, edge) | low | Only after a regression that already fails the test | reject |
| 7 | One-character slugs share a database-wide namespace (blind) | low | Approved spec handles taken candidates and fails clearly; no other file uses them | reject |
| 8 | The Better Auth id generator is copied from another test file (blind) | low | Five lines in test code; sharing adds a new helper for no named failure | reject |
| 9 | The no-slug update test does not prove the skip (blind) | false | Removing the `typeof` guard makes `isSlug(undefined)` throw, a 500 the test's 200 assertion catches | reject |
| 10 | The server-side `auth.api` path is untested with an off-rule slug (blind) | low | better-call validates and runs the same endpoint, hooks included; the seed's slug is in the rule | reject |
| 11 | Sprint status says in-progress; the spec is not in the diff; 9.4 closed here (blind) | false | Step 5 sets review; the spec is withheld by design; the owner asked for 9.4's bookkeeping here | reject |

## Implementation Notes

- Review patches applied: `atLimit` is created through Better Auth again in `public-status-page.integration.test.ts`; only `overLimit` and `offRule` are inserted directly, with comments saying they stand for organizations created before the hooks.
- Pre-existing organizations outside the rule, as DOMAIN.md asks: the local database holds 2 organizations, 0 outside the rule. No other database exists to count.
- `db:seed` was a no-op (`acme-demo` exists); its slug is inside the rule and the hook runs on that path too.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass both times. `auth.ts` must not gain an import that breaks the unit job.
- `pnpm run test:integration`, twice -- expected: all pass. A timeline-order failure is this machine's clock (deferred-work.md); re-run it.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds. A no-op if `acme-demo` exists; say so when presenting.
