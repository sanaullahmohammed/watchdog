---
title: 'GH #147 — bound the public page limit''s fragment walk'
type: 'bugfix'
created: '2026-10-27'
status: 'done'
baseline_commit: 'ebbb2800fcb8a581e26219ccd09db3ca2808804c'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `onePublicPagePerOperation` (`src/server/graphql-public-page-limit.ts`) walks a fragment's selection set again for every spread that reaches it. A fragment spread twice inside a fragment that is itself spread twice is walked 2^depth times. Every `/graphql` request runs this synchronous validation rule, anonymous requests included. Here an 898-byte valid query takes 732 ms, and each extra level doubles the time; the issue measured 984 bytes at 3.4 s. One small request blocks the event loop for every caller.

**Approach:** Count each fragment once per document and reuse that count at every spread. On a valid document a fragment's count does not depend on the path that reached it. The rule's meaning is unchanged: one `publicStatusPage` per operation, aliases and fragments included, and two spreads of one fragment count twice (ARCHITECTURE 5.4.1). The tests measure work by counting walks, not by timing.

## Boundaries & Constraints

**Always:**
- No selection set is walked more than once per validated document, so the work is linear in the document's size.
- The memo is created per `validate` call, inside the rule's `(context) => …` closure, never in module or factory scope. A memo outside it would carry one request's fragment counts into the next request and bypass the limit. The operations of one document share it.
- Counts are exact for valid documents up to `Number.MAX_SAFE_INTEGER` and saturate there. Every addition goes through one saturating helper, field increments included. A saturated count is reported as `at least 9007199254740991`. Below that the message is unchanged: `publicStatusPage may be selected once per operation; this one selects it N times`.
- Each operation is counted and reported on its own, as it is now.
- A fragment cycle is illegal, and `NoFragmentCyclesRule` reports it. Here it only needs to stay finite. A spread of a fragment whose count is still being computed contributes 0. Counts in a cyclic document may differ from the old rule's; such a document never executes.
- A spread of an unknown fragment contributes 0, as now. Only spreads and inline fragments are followed, never field sub-selections, as now.
- Every test that could become exponential without the memo runs under a walk budget that throws on the first selection set walked twice. The one exception is the timed backstop, whose depth is fixed at 24. `validate` rethrows a rule's exception (graphql 16), so removing the memo fails the suite and never hangs it.

**Never:**
- No change to the wiring in `src/server/index.ts`, to mercurius options (no `maxTokens`, no depth limit), or to other rules.
- No timing assertion except one backstop with a generous bound.
- No edits to `docs/genesis/*` or `AGENTS.md`.

## I/O & Edge-Case Matrix

A *doubled chain of depth N* is `{ ...F0 }`. Each of `F0` to `F(N-1)` is `fragment Fi on Query { ...F(i+1) ...F(i+1) }`, and `F(N)` is the bottom. Its count is 2^N times the bottom's count. `<page>` is `publicStatusPage(orgSlug: "x") { overallStatus }`, aliased where it appears more than once in one selection set.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Doubled chain, no page | depth 16, bottom `__typename` | no errors | budget |
| Doubled chain, page | depth 20, bottom `<page>` | one error, `selects it 1048576 times` | budget |
| Overflow | depth 60, bottom `<page>` | one error, `selects it at least 9007199254740991 times` | budget |
| Shared fragment, two operations | `query A { ...P } query B { ...P } fragment P on Query { <page> }` | no errors | budget |
| Shared fragment, twice in one op | `query A { ...P ...P } fragment P on Query { <page> }` | one error, `2 times` | budget |
| Memo is per document | one rule instance, two `validate` calls: first `{ ...P } fragment P on Query { __typename }`, then `{ ...P ...P } fragment P on Query { <page> }` | first: none; second: one error, `2 times` | — |
| Cycle | `{ ...A } fragment A on Query { ...B ...B } fragment B on Query { ...A ...A <page> }` | this rule alone: one error, `2 times`; with `specifiedRules` also at least one `Cannot spread fragment` error (graphql reports it twice here) | budget |
| Unknown fragment | `{ ...Missing }` | no error from this rule | — |
| Existing cases | aliases, inline fragments, several operations, other fields | unchanged | — |

</frozen-after-approval>

## Code Map

- `src/server/graphql-public-page-limit.ts` -- the rule. `countSelections` (lines 29-63) recurses into `context.getFragment(name).selectionSet` once per spread, and carries a `spreads` path only to stop cycles. The rule walks fragments itself, outside graphql's visitor, so it needs its own cycle guard. `onePublicPagePerOperation` (line 65) is what `src/server/index.ts:164` hands mercurius as `validationRules`. This is the only `getFragment` call under `src/`.
- `src/server/graphql-public-page-limit.spec.ts` -- unit tests against the real schema (`buildSchema(await getGQL())`), with only this rule applied. Keep every existing case unedited.
- `src/modules/status-page/public-surface-bounds.integration.test.ts:60` -- the HTTP-level check, which matches the message prefix only. It must stay green; do not edit it.
- Measured at the baseline: doubled chains of depth 10, 16, 20 and 22 (418, 658, 818 and 898 bytes) took 4, 16, 171 and 732 ms. Depth 24 is about 3 s.
- A chain of 5,000 single spreads already overflows the stack inside graphql-js's own `specifiedRules`. Recursion depth is not this rule's problem, so the walk may stay recursive.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/graphql-public-page-limit.ts` -- Add an exported factory `createOnePublicPagePerOperation(observe?: (selectionSet: SelectionSetNode) => void): ValidationRule`. It calls `observe` at the start of each selection-set walk. A one-line doc comment says `observe` is a test seam that production never passes. Export `onePublicPagePerOperation = createOnePublicPagePerOperation()`. Keep the old per-spread walk for now. -- gives the tests a counter.
- [x] `src/server/graphql-public-page-limit.spec.ts` -- Add a doubled-chain builder and a budget observer that records each `SelectionSetNode` and throws on the first one it sees twice. Create a fresh budget for each `validate` call. Cover every Matrix row, routing the rows marked "budget" through `createOnePublicPagePerOperation(budget)`. Add one backstop on the exported `onePublicPagePerOperation`: a doubled chain of depth 24 with no page gives no errors in under 1000 ms, measured with `performance.now()` around `validate` only, with parsing outside the timed region. It takes about 3.5 s without the memo here, so it fails rather than hangs. A much faster machine could let the old walk pass it; that is acceptable because the budget tests carry the proof. Run the spec and confirm the budget tests fail. Record that run in Implementation Notes. It is observed, never committed, and never bypassed with `--no-verify`, because the pre-commit hook runs the unit tests. -- reproduce first.
- [x] `src/server/graphql-public-page-limit.ts` -- Add the memo, a `Map<string, number>` created inside the context closure. A fragment is set to 0 before it is walked. Add the saturating helper and the `at least …` wording. Drop the `spreads` path. Update the header comment: each fragment is counted once per document and reused per spread, and why. Match the file's comment style. -- the fix.

**Acceptance Criteria:**
- Given the factory with the old walk, when the new spec runs, then the budget tests fail.
- Given the fix, when the spec runs, then every Matrix row passes and so does the backstop.
- Given the fix, when the memo is removed, then the spec fails without hanging.
- Given the fix, when the memo is moved to factory scope, then the "memo is per document" row fails.
- Given the fix, when `pnpm run test` runs, then every existing case in the spec passes unedited, and so does `public-status-page.contract.spec.ts`.

## Implementation Notes

- Reproduction (not committed): with `createOnePublicPagePerOperation(observe?)` added around the old per-spread walk, the new spec failed 7 tests. The six budget rows threw "selection set walked twice", and the backstop took 4045 ms. After the memo, all 14 tests pass and the backstop takes under 1 ms.
- Sabotage 1, memo removed (`fragmentCounts.delete(name)` after the walk, which keeps only the in-progress cycle marker): 7 tests fail, the 6 budget rows and the backstop (2482 ms). Nothing hangs.
- Sabotage 2, memo moved to factory scope: only "keeps the memo per document" fails, as intended.
- Review patch (triage #6): `chain` takes an `inline` flag, and "counts a doubled chain exactly through inline fragments" (depth 16, `65536 times`) runs under the budget. With the memo removed it fails too, so 8 tests fail.
- Verification: `pnpm run check` clean (11 Biome warnings, all pre-existing in other files). Unit 478/478 with `.env` and 478/478 without it. Integration 852/852, run before the review patch, which touched only the unit spec; the rule file is byte-identical. e2e 12/12 scenarios. `auth:schema:check` in sync.
- A spread of an unknown fragment is not memoized. Each one costs a single `getFragment` map lookup, which is still linear.

## Spec Change Log

## Review Triage Log

| # | Layer | Finding | Verdict | Evidence | Route |
|---|-------|---------|---------|----------|-------|
| 1 | edge case | In a fragment cycle, a fragment counted while an ancestor sits at placeholder 0 is memoized with a partial count, so this rule can under-report | false | `NoFragmentCyclesRule` runs beside it in mercurius (`node_modules/mercurius/index.js:493`), so a cyclic document is rejected and never executes. No limit is bypassed, and the Boundaries accept that counts in a cyclic document may differ | reject |
| 2 | blind | The fix is never exercised through mercurius with `specifiedRules`, so rewiring could bring #147 back | low | `public-surface-bounds.integration.test.ts:60` proves the wired rule is this module's, by its message. The unit spec proves that export is bounded. Only a rewire to a different object escapes, and nothing suggests one | reject |
| 3 | blind | The saturation edge is not pinned, and a count of exactly `MAX_SAFE_INTEGER` reads "at least" | false | "At least 9007199254740991" is true when the count equals it. The depth-60 test pins the printed cap, so moving the cap changes the message and fails the test | reject |
| 4 | blind | The cycle test pins an arbitrary "2 times" | low | The frozen Matrix requires "one error, `2 times`"; the value is the old rule's too | reject |
| 5 | blind | A test-only `observe` parameter is exported from production code | low | It is documented as a test seam. `index.ts:164` passes the seam-free `onePublicPagePerOperation` | reject |
| 6 | blind | No budget test doubles through inline fragments | low | The code shares one walk, but nothing pins it against a refactor that memoizes only bare spreads. The fix is one test | patch |
| 7 | blind | The backstop's margin is about 3.5x, and it is the only test of the exported singleton | low | Spec Tasks accept the margin because the budget tests carry the proof. The singleton is `createOnePublicPagePerOperation()` and runs the same code with `observe` undefined | reject |
| 8 | verification gap | none | — | No gaps filed | — |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean
- `pnpm run test` -- expected: all pass, also with `.env` moved aside
- `pnpm run test:integration` -- expected: all pass, `public-surface-bounds` included
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass
