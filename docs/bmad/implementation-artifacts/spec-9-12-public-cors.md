---
title: 'Story 9.12 — Public CORS headers on every answer'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: 'dc1880fa80ace7b19df70241445d627506e94fd8'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `GET /status/:orgSlug` sets its CORS headers inside the handler, after the page has been read. A 404 (the uniform miss, thrown by the slug lookup) and a 429 (the rate limiter, which runs before the handler) therefore go out without them. A browser script on another origin cannot read those answers at all; it sees only an opaque network error (audit F-12; ARCHITECTURE 5.4.1).

**Approach:** The route sets its public headers in its own `onSend` hook, which runs for every answer the route gives, error answers included. The headers are unchanged: `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: ETag`, `Cross-Origin-Resource-Policy: cross-origin`, and no credentials.

## Boundaries & Constraints

**Always:**
- The same three headers on 200, 304, 404 and 429, and still none of `Access-Control-Allow-Credentials`.
- The global CORS registration stays `origin: false`, so no authenticated route gains any CORS header.
- The OPTIONS preflight is unchanged.

**Never:**
- No change to `/graphql`'s CORS. ARCHITECTURE 5.4.1 scopes CORS to the public page.
- No new exposed headers. Exposing `Retry-After` would be a change to 5.4.1 first.
- No change to the rate limit, the ETag logic or the uniform 404 body.
- **Out of scope:** a request the router answers itself never reaches this route, so it gets no headers. Examples are `/status/x/` (trailing slash) and `/status/a/b`. It is recorded in `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Request (with `Origin: https://example.test`) | Expected |
|---|---|---|
| Page | an existing slug | 200, the three headers |
| Not modified | the page's `If-None-Match` | 304, the three headers |
| Miss | an unknown slug, and a slug outside the slug rule | 404, the three headers |
| Rationed | past the limit | 429, the three headers |
| Admin route | `GET /api/v1/services` | no `access-control-allow-origin` |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts`
  - :42-47 opt the route into the rate limit. The limiter's route-level `onRequest` answers 429 before the handler runs.
  - :51-55 is the route's `onSend`, which today only strips `content-length` from a 304.
  - :56-79 is the GET handler: the query (which throws `NotFoundException` on a miss), then `publicHeaders(res)` at :65, then `cache-control` and `etag`.
  - :86-97 is the OPTIONS route. It calls `publicHeaders` at :91 and has no `onSend`.
  - :100-117 hold `publicHeaders` and its comment.
- Verified with a throwaway Fastify 5.7 app before planning:
  - A route-level `onSend` runs for the 200, the 304, a 404 from the error handler, and a 429 from the limiter's route hook.
  - Helmet sets its headers in `onRequest`, so `cross-origin-resource-policy: cross-origin` set in `onSend` wins.
  - `retry-after` is kept.
- `src/shared/domain/slug.ts:8` -- `SLUG_PATTERN`. `Not_A_Slug` fails it, and an unknown valid slug passes it; both 404 through the same `NotFoundException` in the slug lookup.
- `src/server/plugins/error-handler.ts` -- sends the 404 and 429 bodies. Fastify runs the route's `onSend` hooks for those replies too, and headers set there are kept.
- `src/server/index.ts:78-82` -- `register(Cors, { origin: false })`, unchanged.
- `src/modules/status-page/public-surface-bounds.integration.test.ts`
  - :23-24 hold `fetchPage(headers)`, which always requests `/status/${tag}`.
  - :114-146 hold the existing CORS assertions, on a 200 and the preflight.
  - :148-157 assert the admin route stays closed.
  - :172-205 hold the 429 through a separate `limited` app and `flood()`. Its page request at :192-194 sends no headers.
  - No test reads a 404.

## Tasks & Acceptance

**Execution:**
- [x] `get-public-status-page.public.route.ts` -- call `publicHeaders(res)` at the start of the GET route's `onSend`, before the 304 branch, and remove the call from the GET handler (:65). The OPTIONS handler keeps its call (:91). Update the comment on `publicHeaders` to say why it runs in `onSend`.
- [x] `public-surface-bounds.integration.test.ts`
  - One helper asserts the three headers and the absence of `access-control-allow-credentials`.
  - Apply it to:
    - the cross-origin 200;
    - the 304;
    - two 404s, sent with `app.inject` directly, with an `origin` header: `/status/${tag}-missing` and `/status/Not_A_Slug`;
    - the 429 in the existing `limited` flow, whose page request gains `origin: https://example.test`.
  - Keep the admin-route assertion.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append one entry for the router-404 gap (out of scope above), and any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when the request is answered, then the headers match the matrix.
- Given the `publicHeaders` call moved back into the GET handler and removed from `onSend`, when the suite runs, then the 404 and 429 assertions fail. Check this once by hand.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice -- expected: all pass. Re-run a timeline-order failure; it is this machine's clock.
- `pnpm run test:e2e` -- expected: all scenarios pass.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op.

## Implementation Notes

- One line moved: `publicHeaders(res)` now runs in the GET route's `onSend`, so every answer the route gives carries the headers.
- Checked by hand: with the call moved back into the handler, the CORS test (200, 304 and both 404s) and the 429 test fail, 2 of 7; restored, 7 of 7 pass.
- No review patches. Four findings deferred:
  - HEAD with a matching `If-None-Match` answers 500, reproduced, and it predates this story.
  - A malformed percent-encoding is a router 400 without the headers.
  - `Retry-After` is not exposed.
  - 5.4.1's wording.
- Verified: check clean; unit 123/123 with and without `.env`; integration 338/338 twice; e2e 3/3; auth schema in sync; `db:seed` a no-op.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `HEAD /status/:orgSlug` with a matching `If-None-Match` answers 500: Fastify's HEAD `onSend` meets the `null` this route returns for a 304 (edge) | medium | Reproduced: GET 200 with an ETag, then HEAD with that tag gave 500. The 304 branch predates this story | defer |
| 2 | A malformed percent-encoding (`/status/%E0`) is a router 400 with no CORS headers; a not-found handler would not cover it (edge) | low | Reproduced: 400, no `access-control-allow-origin`. Same class as the router-404 gap | defer |
| 3 | ARCHITECTURE 5.4.1 does not say the headers go on every answer, nor record the router gap (blind) | low | 5.4.1's decision is unchanged ("the page sets the headers itself"); the rule is now enforced and tested | defer |
| 4 | A cross-origin script cannot read `Retry-After` on the 429 (blind) | low | Only `ETag` is exposed; changing that is a 5.4.1 decision | defer |
| 5 | A 500 now carries the headers untested; HEAD and the preflight's other headers are not asserted (blind) | low | Additive; the preflight code is unchanged and still tested for origin, methods and headers | reject |
| 6 | The 304 check does not first assert an ETag; the test title and the stacked route comments no longer fit (blind) | low | A missing ETag still fails the test, as a 200; cosmetic otherwise | reject |
| 7 | The spec is untracked; statuses differ; no record of the hand check (blind) | false | The spec is withheld from reviewers by design and committed with the code; step 5 sets review; the implementer ran the hand check, recorded below | reject |
