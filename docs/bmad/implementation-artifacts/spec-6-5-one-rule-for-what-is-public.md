---
title: 'Story 6.5: One rule for what is public'
type: 'refactor'
created: '2026-10-22'
status: 'done'
baseline_commit: '6e4707c498a029ce92c30b9e0ae6a170a9f4a2fe'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** DOMAIN's Public status page rule (`publishable`, `overallStatus`, and the `AffectedService` and `Published<T>` types) lives in `src/modules/status-page/domain/public-page.ts`. Modules never import each other, so the notification pass (6.6) and the Atom feed (6.8) cannot use it without copying it. ARCHITECTURE 5.6, "One rule for what is public", says the rule moves into `src/shared` and nobody keeps a copy.

**Approach:** A pure move with no behaviour change.
- `git mv` `src/modules/status-page/domain/public-page.ts` and `public-page.spec.ts` to `src/shared/domain/`, so history follows them. `src/modules/status-page/domain/` is then empty and disappears.
- Change only the four import specifiers from `@/modules/status-page/domain/public-page` to `@/shared/domain/public-page`:
  - `src/modules/status-page/dtos/public-status-page.present.ts:5`
  - `src/modules/status-page/database/public-status.repository.ts:1`
  - `src/modules/status-page/queries/get-public-status-page/get-public-status-page.handler.ts:10-13`
  - the moved spec (line 7)
- A repo-wide grep found no other importer, including tests, features, scripts and config.
- Biome's `organizeImports` runs in the pre-commit hook (`biome check --write`). It will move the renamed import to its sorted place in the presenter, the repository and the handler. That is expected. Run `pnpm exec biome check --write` on the touched files before committing, so the hook changes nothing. `pnpm run check` does not sort imports, so it will not catch this.
- The moved file's only import is already `@/shared/domain/status-inputs`, so it imports nothing from `src/modules`.
- The stream, the GraphQL resolver and every test reach the rule through the handler and presenter. They are not edited.

**Done when:**
- No definition of `publishable` or `overallStatus` is left under `src/modules`. The `overallStatus` field of the response DTO and the SDL is a response field, not a copy of the rule.
- `grep -rn "status-page/domain" src` finds nothing.
- `git diff -M` against baseline shows two renames.
- File contents change only in import statements: the specifier, and Biome's reordering.
- `pnpm run check` and `pnpm exec biome check` on the touched files both pass. `check` includes dependency-cruiser.
- `pnpm run test` passes with `.env` present, and again with it moved aside.
- `pnpm run test:integration`, `pnpm run test:e2e` and `pnpm run auth:schema:check` pass, using AGENTS.md's setup.
- No test file is edited, apart from the moved spec's import line.
- Story AC 2 ("a later reader in another module imports `src/shared/domain/public-page.ts` and dependency-cruiser passes") has no such reader yet. It is met by where the rule now lives: nothing forbids importing `src/shared` from a module. 6.6 and 6.8 are its first readers.

**Not in scope:**
- No new exports, renames or comment edits. The doc comment's wording ("what the public page shows") stays; 6.6 and 6.8 may extend it.
- No test, migration, config or GraphQL change.
- No edits to `docs/genesis/*` or `AGENTS.md`.
- Append one entry under a new `## From Story 6.5 (2026-10-22)` heading at the end of `docs/bmad/implementation-artifacts/deferred-work.md`, in the 6.4 entries' format:
  - `source_spec` is this spec.
  - `summary`: ARCHITECTURE names the old location. Line 392 calls `src/modules/status-page/domain/public-page.ts` the rule's location, and line 543 says the rule "moves from `status-page/domain/public-page.ts` into `src/shared`". Both should name `src/shared/domain/public-page.ts` as built.
  - `evidence`: a genesis edit needs the owner's OK.
  - `target`: Owner decision, raised with story 6.5's PR.
- **Decision (owner, 2026-10-22, option A):** the SQL visibility predicate (`is_public and archived_at is null`, `src/modules/status-page/database/public-status.repository.ts:226,304`) stays where it is; 6.5 remains a pure move. Append a second entry under the same heading: `summary`: the "visible service" predicate is SQL in the status-page repository, not in `src/shared/domain/public-page.ts`, so 6.6 and 6.8 would restate it; ARCHITECTURE 5.6 says none keeps a copy, so they should share it (for example a shared SQL fragment or view) rather than copy it. `evidence`: story 6.5 spec review, owner decision A. `target`: Story 6.6 (first reader), then 6.8.

</frozen-after-approval>

## Implementation Notes

- Moved with `git mv`: `public-page.ts` and `public-page.spec.ts` from `src/modules/status-page/domain/` to `src/shared/domain/`. Both show as 100% / 98% renames.
- Import specifier changed in the presenter, the repository, the handler and the moved spec. No other content changed.
- Biome reordered imports in three files: the presenter and the repository (the shared import now sits after the `@/modules` imports) and the handler (the import merged onto one line and moved below `withTenantTransaction`). The spec needed no reorder.
- Added two entries under `## From Story 6.5 (2026-10-22)` in `deferred-work.md`: the stale ARCHITECTURE path (lines 392, 543) and the shared SQL visibility predicate (owner decision A).
- Surprise: none. `pnpm run check` reports 11 Biome warnings, none from touched files. Unit run here was with `.env` present only.
- Review: the main session's `git reset` (after staging the review diff) unstaged the `git mv`. The renames are re-staged with `git add -A` at commit and checked as R100/R98 with `git diff --cached -M --stat`.
- Verification (main session, 2026-10-22, after the review patches):
  - `pnpm run check`: passes. Its 11 Biome warnings are all in untouched files (`src/shared/cqrs/*`, `tests/support/*`). dependency-cruiser reports no violations (515 modules).
  - `biome check` on the five touched files: no fixes.
  - `pnpm run test`: 429/429 with `.env` present, and 429/429 with `.env` moved to `$HOME/.cache/watchdog-env-aside`.
  - `pnpm run test:integration` (postgres, mailpit and migrate only): 775/775 on the first run, no reruns needed.
  - `pnpm run test:e2e`: 10 scenarios, 86 steps, all passed.
  - `pnpm run auth:schema:check`: in sync.
- Mutation checks on `src/shared/domain/public-page.ts`, each restored byte-identical afterwards:
  - Making every affected service count as visible fails 3 of the moved spec's 8 tests.
  - Leaving incidents out of the banner fails 2 of them.

## Review Triage Log

Pass 1 (blind hunter, edge case hunter, verification gap; same model as the session).

1. false — "Most required verification is not recorded" (blind hunter; edge case hunter #2; verification gap, other #1). The runs belong to the verification step that follows review: unit with and without `.env`, integration, e2e and `auth:schema:check` run before the spec is finalized and are reported with it. Not a defect in the change.
2. low, patch — the renames show as `D` plus `??`, so `git commit -a` would drop the new files (blind hunter; edge case hunter #1). Real: the session's `git reset` unstaged the `git mv`. Fixed at commit with `git add -A` and a `--cached -M` check.
3. low, patch — `src/modules/status-page/domain/` was left empty on disk, and the spec says it disappears. Commits ignore it; removed with `rmdir`.
4. low, patch — deferred entry 1 used a free-text target and gave a reason as evidence, while the file header defines "Genesis edit (owner)". Corrected.
5. low, patch — deferred entry 1 cited bare line numbers, which go stale with the next genesis edit. It now names the sections, with the line numbers as hints.
6. medium (not yet acted on), defer — nothing stops 6.6 or 6.8 from re-defining `publishable` or `overallStatus` inside its own module. The "no copy" check was a one-time grep, and dependency-cruiser blocks imports only. Deferred-work entry 3 proposes a guard spec, target story 6.6.
7. low, patch — deferred entry 2 dropped the predicate's locations and the coupling: `AffectedService.visible` is documented in words, so every caller has to compute it in SQL the same way. Added.
8. low, defer — the moved file's doc comments speak only of the page, and of "Epic 4's public event gate". The approved spec keeps comment edits out of the move, so this is deferred-work entry 4 for story 6.6, which is the first to import the rule elsewhere.
9. false — "status skips `review`". The spec is `in-review`, and sprint-status moves to `review` when the spec is finalized, as the workflow orders it.
10. false — verification gap, other #2: the stale ARCHITECTURE path is already deferred-work entry 1, as the reviewer noted.
