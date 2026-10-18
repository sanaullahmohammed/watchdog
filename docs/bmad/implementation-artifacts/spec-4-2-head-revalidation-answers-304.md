---
title: 'Story 4.2 — HEAD revalidation answers 304'
type: 'bugfix'
created: '2026-10-18'
status: 'done'
baseline_commit: '56f37c582fc173144a144190609558fa6f485d48'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `HEAD /status/:orgSlug` with a matching `If-None-Match` answers 500 instead of 304 (`deferred-work.md`, story 9.12's HEAD entry). The page route's `onSend` returns `null` for a 304. Fastify's automatic HEAD route then appends its own `onSend` (`node_modules/fastify/lib/head-route.js`), which calls `Buffer.byteLength(null)` and throws.

**Approach:** The page route declares `HEAD` itself, as `method: ['GET', 'HEAD']`, so Fastify adds no automatic HEAD route and the route's own `onSend` governs both methods. For `HEAD`, that `onSend` does what Fastify's HEAD handler did: it sets `content-length` from the payload and sends no body. A 304 keeps today's branch: no `content-length` and no body.

**Decisions (owner, 2026-10-18):**
- The page's GET and HEAD share one rate-limit bucket. That is what `method: ['GET', 'HEAD']` gives. Today the automatic HEAD route has a bucket of its own.
- ARCHITECTURE 5.4.1's rate-limit bullet gains one clause: the page's GET and HEAD share one bucket.

## Boundaries & Constraints

**Always:**
- A HEAD answer of any status (200, 304, 404, 429) carries the public headers and no body. Every non-304 answer keeps the `content-length` the GET would have had.
- A GET's answers are unchanged: status, headers and body.
- `HEAD /status/:orgSlug` is allowlisted by name in `PUBLIC_BY_DESIGN`.
- **Constraint 11:** with the fix reverted, the HEAD-304 test answers 500. Implementation Notes record that.

**Never:**
- No `setNotFoundHandler`.
- No change to the catch-all routes, `frameworkErrors`, the slug rule, the `ETag` computation or the GraphQL surface.
- No change to the preflight's `access-control-allow-methods` (`GET, OPTIONS`). HEAD is a CORS-safelisted method.
- Do not return `undefined` for the 304. The probe showed that the HEAD handler then announces `content-length: 4`, which is the length of the string "null".

## I/O & Edge-Case Matrix

| Scenario | Request | Expected |
|---|---|---|
| HEAD, matching tag | `HEAD /status/:slug`, `If-None-Match` = the GET's `ETag` | 304, empty body, no `content-length`, the same `etag`, the public headers |
| HEAD, other tag | `HEAD` with `"not-this-one"` | 200, empty body, `content-length`, `etag` and `cache-control` equal to the GET's, the public headers |
| HEAD, unknown slug | `HEAD /status/<missing>` | 404, empty body, the public headers |
| HEAD, rationed | `HEAD` after GETs spent the page's limit | 429, empty body, the public headers, `retry-after` |
| GET unchanged | `GET` with and without a matching tag | as before: 200 with the body, 304 with no `content-length` |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts`
  - :30-86 is the page route. `method: 'GET'` becomes `['GET', 'HEAD']`.
  - :57-62 is `onSend`. For a 304, keep the existing branch. For a HEAD of any other status:
    - When the payload is a string or a Buffer, set `content-length` to `Buffer.byteLength(payload)` and return `null`.
    - Otherwise return the payload unchanged. `Buffer.byteLength(null)` throws.
    - This reproduces only the string and Buffer cases of Fastify's `head-route.js`. Those are the only payloads this route produces: the serialized page, and the error handler's JSON for a 404, 429 or 500.
  - `req.method` is `'HEAD'` inside `onSend`.
  - Fastify keeps a HEAD reply's `content-length` when the payload is null (`node_modules/fastify/lib/reply.js:615`).
  - Reviewer probe: `/tmp/claude-1000/-home-sleipnir-projects-watchdog/9063f562-9357-4685-97ea-c597e3ed8067/scratchpad/spec-review/p.mjs`. It confirmed the design, including one shared bucket, because `@fastify/rate-limit` builds one store per `onRoute` call (`index.js:172-179`).
  - Swagger (`src/server/plugins/swagger.ts`) will now document a `head` operation for the page. That is acceptable, because the operation is real. Check that `/api-docs/json` still builds.
  - Without that HEAD branch, `app.inject` shows an 11-byte body on a HEAD 200, although Node sends none on the wire, so the test could not see "no body".
  - Update the comment above `onSend` to say why the route declares HEAD itself.
  - Leave the catch-all routes (:105-143) and their automatic HEAD alone.
- `src/shared/api/contract/authenticated-surface.spec.ts:38-61`, `PUBLIC_BY_DESIGN`. Add `HEAD /status/:orgSlug`. The spec reads literal method arrays (:136-151), so it now discovers HEAD.
- `src/modules/status-page/public-surface-bounds.integration.test.ts`
  - :79-107 is the 304 test, and `fetchPage` is at :25.
  - :121-165 is the CORS test with `assertPublicHeaders`.
  - Add the HEAD test beside them.
- The probe, outside the repo: `/tmp/claude-1000/-home-sleipnir-projects-watchdog/9063f562-9357-4685-97ea-c597e3ed8067/scratchpad/head-probe/probe.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] `get-public-status-page.public.route.ts`: declare HEAD, add the HEAD branch in `onSend`, update the comment.
- [x] `authenticated-surface.spec.ts`: add `HEAD /status/:orgSlug` to `PUBLIC_BY_DESIGN`, with the reason "the same page's revalidation without a body".
- [x] `public-surface-bounds.integration.test.ts`: one test per matrix row, each sent with `Origin`. The "other tag" row compares headers with a GET sent just before it, and asserts `content-length` equality explicitly.
- [x] `public-surface-bounds.integration.test.ts`, the shared bucket: on the separate `limited` app, spend the page's limit with GETs. Then a HEAD answers 429, with the public headers and `retry-after`.
- [x] `docs/genesis/ARCHITECTURE.md` 5.4.1, the rate-limit bullet: add "the page's GET and HEAD share one bucket, unlike the catch-all routes (CORS bullet)". The 304 sentence already holds; leave it.
- [x] `deferred-work.md`: remove the 9.12 HEAD entry.
- [x] Constraint 11: revert the route change, run the new test, and record the 500 in Implementation Notes.

**Acceptance Criteria:**
- Given any matrix row, when the request is answered, then the status, headers and body match the matrix.
- Given the page's limit spent by GETs, when a HEAD follows, then it answers 429.
- Given the fix reverted, when the HEAD test runs, then it fails with a 500.

## Implementation Notes

Constraint 11: with `method: 'GET'` restored in the route (automatic HEAD), the new HEAD test fails with `500 !== 304`, and the shared-bucket test fails too. With the fix, both pass.

**After the review patches (rows #1-#5, #7, #8):**
- The implementer reported the row #7 rewording done, but the file was unchanged. The orchestrator applied it.
- The orchestrator verified each of these:
  - Constraint 11, before the patches: with `method: 'GET'` restored, the HEAD test fails with `500 !== 304`, and the bucket test fails with `500 !== 429`.
  - `pnpm run check`: clean. Biome's 11 warnings are all in files this change does not touch.
  - Unit: 265 of 265, with `.env` and without it.
  - Integration: 654 of 654, twice, with no failures to rerun.
  - e2e: 4 of 4.
  - The auth schema is in sync.
  - `/api-docs/json` answers 200 and lists `get` and `head` for `/status/{orgSlug}`.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-18): blind hunter, edge-case hunter, verification gap (no gaps found).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The GET 304's missing `content-length` is unasserted, though the diff restructures the branch both methods share (blind) | low | "tells a poller" asserts only `body` and `etag`; the matrix's "GET unchanged" row says no `content-length` | patch |
| 2 | The HEAD 404 and 429 are never compared with the GET's `content-length` (blind) | low | The Always clause covers every non-304; only the 200 is compared | patch |
| 3 | Three matrix rows share one `it`, against the task "one test per matrix row"; the first failure hides the rest (blind, edge) | low | The diff's "answers HEAD like the GET…" test | patch (split) |
| 4 | The HEAD miss omits the slug outside the rule (`Not_A_Slug`) that the GET CORS test sends (blind) | low | That slug fails in `resolveOrganizationBySlug`, a separate path | patch |
| 5 | The HEAD branch handles only string and Buffer payloads, and the comment claims full parity with Fastify's handler (blind, edge) | low | Unreachable: this route only ever sends the serialized page or the error handler's JSON string. The comment overclaims | patch (comment only); reject the extra branches |
| 6 | Swagger now documents a `head` operation with the 200 JSON body schema (blind, edge) | low | `@fastify/swagger` `add-hook.js:14` skips HEAD only when `method === 'HEAD'`. The spec accepted the operation; hiding it needs a transform in `swagger.ts`, more than a direct correction | reject |
| 7 | The `PUBLIC_BY_DESIGN` reason calls HEAD a revalidation, but a HEAD without `If-None-Match` is the page's headers (blind) | low | `authenticated-surface.spec.ts`, the new entry | patch |
| 8 | The bucket test never asserts the GETs reached 429 before the HEAD; `spent` is unread (blind, edge) | low | With a short `PUBLIC_RATE_LIMIT_WINDOW_MS` the failure would blame the wrong cause | patch |
| 9 | Sprint status says `in-progress` while the spec says `in-review` (blind) | false | Step 5 syncs the sprint status to `review` | reject |
| 10 | The spec is not in the diff (blind) | false | Withheld from reviewers by design and committed with the code, as in 4.1 | reject |

## Verification

**Commands:**
- `pnpm run check`: expected clean.
- `pnpm run test`, then again with `.env` moved aside: expected all pass.
- `pnpm run test:integration`, twice: expected all pass. Rerun any failure two or three times and report it (AGENTS.md clock pitfall).
- `pnpm run test:e2e`: expected all scenarios pass.
- `pnpm run auth:schema:check`: expected in sync.
