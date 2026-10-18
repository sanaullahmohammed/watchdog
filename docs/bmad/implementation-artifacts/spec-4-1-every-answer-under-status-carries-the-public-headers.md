---
title: 'Story 4.1 — Every answer under /status/ carries the public headers'
type: 'bugfix'
created: '2026-10-18'
status: 'done'
baseline_commit: '5685377284970f151bb7ea03139700434613b5f6'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 9.12 put the public headers on every answer the `/status/:orgSlug` route gives, but two kinds of answer never reach that route:
- a path the router cannot match, such as `/status/x/` or `/status/a/b`, which gets the router's 404;
- a malformed percent-encoding, such as `/status/%E0`, which gets Fastify's 400.

Neither carries CORS headers, so a cross-origin script sees an opaque network error. Both also echo the requested path in their body, which the page's uniform miss exists to avoid. Separately, a cross-origin script can read a 429 but not its `Retry-After`, because only `ETag` is exposed (`deferred-work.md`, story 9.12 entries).

**Approach (amended 2026-10-18 by the owner, after review loop 1):**
- The public page's route file adds an ordinary catch-all route, for `/status` and `/status/*`, that answers the page's uniform miss. It is rationed and carries the public headers exactly as the page does.
- It is not a not-found handler. Fastify wires the last-set not-found handler into its 404 router's bad-URL path for the whole app, and the first implementation crashed the api on `PROPFIND /api/%E0`.
- A `frameworkErrors` handler answers a malformed URL under `/status/` with a plain 400 that carries the public headers. "Under `/status`" is judged on the path as the router sees it: before any `?`, with duplicate slashes collapsed and any absolute-form origin removed.
- The exposed headers become `ETag, Retry-After`.
- ARCHITECTURE 5.4.1 records all of this.

## Boundaries & Constraints

**Always:**
- **The public headers** are the route's:
  - `access-control-allow-origin: *`
  - `access-control-expose-headers: ETag, Retry-After`
  - `cross-origin-resource-policy: cross-origin`
  - never `access-control-allow-credentials`

  They are defined in one place.
- **A router miss under `/status`,** for any method the catch-all declares, gets the same status and body as the route's miss for an unknown slug: 404, `Status page not found`, with only `correlationId` differing. It is rationed like the page.
- **Each catch-all operation** is allowlisted by name in `PUBLIC_BY_DESIGN`.
- **The bad-URL 400 under `/status/`:**
  - It has the error handler's shape (`statusCode`, `message: 'Bad Request'`, `error`, `correlationId` = the request id).
  - Its response body does not echo the path.
  - It is logged once through `logFailure` at `info`, without a stack, under that `correlationId`.
- **Nothing may crash the process.** Every request answers.
- **Constraint 11:** each new test is shown to fail with its fix reverted, and Implementation Notes record that.

**Never:**
- No `setNotFoundHandler` anywhere.
- No answer outside `/status` changes. That covers `/statusx`, `/api/...`, `/graphql`, and Fastify's default bad-URL and async-constraint answers (status, body, content type and length).
- The global CORS stays `origin: false`.
- The page route's rate limit, `ETag`, 304 logic and slug rule stay as they are.
- `HEAD` with a matching `If-None-Match` is story 4.2.
- Paths that differ from `/status` in letter case (`/STATUS/x/`) are not the public page's path. They keep the root answers, and this is recorded in `deferred-work.md`.

## I/O & Edge-Case Matrix

Every request is sent with `Origin: https://example.test`.

| Scenario | Request | Expected |
|---|---|---|
| Router miss | `GET /status/x/`, `GET /status/a/b`, `GET /status`, `GET //status/x/`, `POST /status/acme`, `HEAD /status/a/b`, `OPTIONS /status/x/` | 404 with the uniform-miss body (no body for `HEAD`) and the public headers |
| Miss rationed | router misses past the limit | 429 with the public headers |
| Bad URL, public | `GET /status/%E0`, `GET /status/%E0/events`, `GET //status/%E0`, `GET /status/%E0?x=1` | 400 with no path in the body, the public headers, and one `info` log line under its `correlationId` |
| Rationed page | the page, past the limit | 429; the exposed headers include `Retry-After`; the `retry-after` header is present |
| Page, preflight | as 9.12 tested them | unchanged, except that the exposed headers include `Retry-After` |
| Outside | `GET /statusx`, `GET /statusx%E0`, `GET /api/nope`, `GET /api/%E0`, `GET /api/%E0?r=/status/`, `POST /graphql` (empty body) | the same status and body as on master, and no public headers |
| No crash | `PROPFIND /api/%E0`, `PROPFIND /status/%E0` | Fastify's default 404, and the app keeps answering |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts`
  - :54-59 is the GET route's `onSend`, which calls `publicHeaders`.
  - :42-47 is its `config.rateLimit`.
  - :89-100 is the OPTIONS route.
  - Add the catch-all here, in this file, which already has a resolver beside it, so the parity spec's coverage holds.
  - The catch-all is two `fastify.route({ method: [...], url })` calls with literal `method` arrays and literal `url`s (`'/status'`, `'/status/*'`), because `authenticated-surface.spec.ts:128-146` reads only that shape.
  - Methods: `DELETE`, `GET`, `OPTIONS`, `PATCH`, `POST`, `PUT`; `HEAD` comes from `GET` automatically.
  - Give it the same rate limit and an `onSend` that calls `publicHeaders`. The handler throws `NotFoundException(PUBLIC_PAGE_NOT_FOUND)`. That is safe in a route handler; it was not in a not-found handler.
  - Probe on 2026-10-18, a plain Fastify 5.7.2 with `ignoreDuplicateSlashes`:
    - `/status/:orgSlug`, `/status/:orgSlug/events` and the OPTIONS route still win.
    - `/status/` still reaches the page route with an empty slug.
    - `OPTIONS /status/x/` reaches the catch-all, beating the global `OPTIONS *`.
    - `//status/x/` reaches the catch-all.
    - `PROPFIND` keeps the default 404.
- `src/shared/api/contract/authenticated-surface.spec.ts:38-53`, `PUBLIC_BY_DESIGN`. Add every catch-all operation (`<METHOD> /status` and `<METHOD> /status/*`) with one shared reason. Building those entries from one methods list is fine. The stale-entry check keeps the list and the route in step.
- `src/server/build-app.ts:21-47`: the Fastify constructor. Pass `frameworkErrors` there.
- `src/server/framework-errors.ts` (new).
  - Fastify 5.7.2 calls it for `FST_ERR_BAD_URL` and `FST_ERR_ASYNC_CONSTRAINT` (`node_modules/fastify/fastify.js:636-690`), before any hook runs.
  - Use `request.id` for `correlationId`, and set `publicHeaders` on the reply directly.
  - Outside `/status`, reproduce the defaults exactly:
    - 400 `{"error":"Bad Request","code":"FST_ERR_BAD_URL","message":"'<path>' is not a valid url component","statusCode":400}`
    - 500 `{"error":"Internal Server Error","message":"Unexpected error from async constraint","statusCode":500}`
    - Both are `Content-Type: application/json`.
  - Setting the option makes Fastify log `incoming request` for every bad URL (`:643-646`). The default branch writes `reply.raw` and so logs no completion. Say so in a comment.
  - Pass 1's version of this file, in `stash@{0}`, is reusable apart from the path normalization.
- `src/shared/api/public-surface.ts` (new): `publicHeaders`, with its comment moved from the route.
- `src/shared/domain/public-page-miss.ts` (new): `PUBLIC_PAGE_NOT_FOUND`. It lives outside `shared/api` because the slug handler (`resolve-organization-by-slug.handler.ts:17`) imports it, and a handler must not depend on the api layer.
- `src/server/error-logging.integration.test.ts`: `logsOf` and `summary` capture log lines by request id. The anonymous-miss case is at about :87-108. Add the bad-URL case beside it.
- `src/modules/status-page/public-surface-bounds.integration.test.ts`
  - :31-44 is `assertPublicHeaders`.
  - :121-165 is the CORS test.
  - :192-230 is the 429 flow, run on a separate `limited` app.
- `docs/genesis/ARCHITECTURE.md` 5.4.1, the CORS bullet.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/api/public-surface.ts` and `src/shared/domain/public-page-miss.ts` (new). Have the route and the slug handler import them.
- [x] `get-public-status-page.public.route.ts`: the catch-all routes, as in the Code Map.
- [x] `authenticated-surface.spec.ts`: add the catch-all operations to `PUBLIC_BY_DESIGN`.
- [x] `src/server/framework-errors.ts` (new), wired into `build-app.ts`, with the normalized path test exported as `isUnderStatus`.
- [x] `src/server/framework-errors.spec.ts` (new), with no database and no `src/config`:
  - Unit-test `isUnderStatus`: a query string, duplicate slashes, an absolute-form URL, and letter case.
  - Compare every outside answer with that of a plain `Fastify()` with no `frameworkErrors`: status, body, `content-type` and `content-length`. That includes the async-constraint answer, provoked through a route with an async constraint strategy that fails, rather than a copied literal.
- [x] `public-surface-bounds.integration.test.ts`:
  - `assertPublicHeaders` expects `ETag, Retry-After`.
  - Apply it to the preflight.
  - Add one test per matrix row. "Outside" asserts the exact status and body that master gives.
  - "No crash" sends both `PROPFIND` requests, then a normal page request, and expects all three to answer.
  - "Miss rationed" uses the `limited` app.
- [x] `error-logging.integration.test.ts`: a `GET /status/%E0` with a `request-id` header. Assert exactly one non-routine line at level 30, with no stack, whose `correlationId` equals the request id and the body's.
- [x] `docs/genesis/ARCHITECTURE.md` 5.4.1, saying:
  - The headers go on every answer under `/status`: the route's own; a router miss, which a rationed catch-all route answers with the uniform miss; and a malformed URL, which `frameworkErrors` answers with a plain 400 that does not echo the path.
  - `Retry-After` is exposed with `ETag`.
  - A request whose method the catch-all does not declare, or a failed async constraint, keeps Fastify's default answer.
- [x] `deferred-work.md`:
  - Remove the three 9.12 entries this closes.
  - Add the letter-case item.
  - Add triage row #14 (AGENTS.md should note the `/status` catch-all, `frameworkErrors`, and that a not-found handler doubles as the app-wide bad-URL handler), targeted at the next AGENTS.md reconciliation.

**Acceptance Criteria:**
- Given any matrix row, when the request is answered, then the status, body, headers and log match the matrix.
- Given each of these reverted one at a time, when the suite runs, then that row's test fails:
  - the catch-all;
  - the `frameworkErrors` public branch;
  - the path normalization;
  - the `Retry-After` exposure.
- Given pass 1's throwing `setNotFoundHandler` restored, when the suite runs, then the "No crash" test fails.
- Record each of these in Implementation Notes.

## Verification

**Commands:**
- `pnpm run check`: expected clean.
- `pnpm run test`, then again with `.env` moved aside: expected all pass.
- `pnpm run test:integration`, twice: expected all pass. Rerun a timeline-order failure before treating it as real (AGENTS.md clock pitfall).
- `pnpm run test:e2e`: expected all scenarios pass.
- `pnpm run auth:schema:check`: expected in sync.

## Spec Change Log

- **Loopback 1 (2026-10-18).**
  - **Trigger:** triage rows #1–#5.
  - **Amended, with the owner's approval:**
    - The Approach: a catch-all route instead of a scoped not-found handler.
    - "Under `/status`" is now judged on the normalized path.
    - The out-of-scope list keeps only letter case.
    - The matrix gains the crash, method, rationing, duplicate-slash and query rows.
    - The patch rows #6–#13 are folded into the tasks.
  - **Known-bad state avoided:** a not-found handler that throws, which Fastify calls unguarded as the app-wide bad-URL handler, so one anonymous `PROPFIND /api/%E0` ends the process.
  - **KEEP:**
    - Pass 1's `framework-errors.ts` structure and its default-body reproduction.
    - The shared `publicHeaders` and its comment.
    - The router-miss test's body comparison against the route's own miss.
    - The 429 `Retry-After` assertion.

## Review Triage Log

Pass 1 (2026-10-18): blind hunter, edge-case hunter, verification gap.

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | One anonymous request crashes the api. Fastify calls the last-set not-found handler as its 404 router's global `onBadUrl` with no promise handling, so the scoped handler's thrown `NotFoundException` is an unhandled rejection (edge) | high | Reproduced on the branch: `PROPFIND /api/%E0` makes the process exit. Master answers 404 and stays up (worktree probe). The mechanism is `fastify/lib/four-oh-four.js:64-71` and `:124-125` | intent_gap |
| 2 | An unrouted-method bad URL outside `/status` reaches the status-page handler, and "nothing outside `/status` changes" is false (edge) | high | The same mechanism as #1: `_onBadUrlHandler` is global | intent_gap (with #1) |
| 3 | Router misses are not rationed, unlike the route's own miss, and each writes an `info` line with no limit (blind) | medium | The scoped handler has no `config.rateLimit`, while the route's 404 does | intent_gap (with #1) |
| 4 | `//status/acme` is the public page (`ignoreDuplicateSlashes`), so the frozen out-of-scope reason "not the public page's path" is wrong. `//status/x/` and `//status/%E0` get the root answers and echo the path (blind) | medium | Probed: `//status/acme` answers 200 with the headers | intent_gap |
| 5 | `isUnderStatus` reads the raw URL. Absolute-form (`http://h/status/%E0`) and duplicate-slash targets miss the public 400 (edge) | low | Reproduced by the reviewer's `repro/abs.ts`; same root cause as #4 | intent_gap (with #4) |
| 6 | The bad-URL 400's log line and `correlationId` are untested; every test runs with `logger: false` (verification) | medium | Pre-verified gap; `error-logging.integration.test.ts` has no malformed-URL case | patch |
| 7 | The async-constraint test compares a hard-coded literal, not a plain `Fastify()`, against the spec's task (verification, blind, edge) | low | `framework-errors.spec.ts:72-95` | patch |
| 8 | ARCHITECTURE 5.4.1 and the `publicHeaders` comment claim "every answer under `/status/`"; the async-constraint answer and exotic methods are exceptions (blind) | low | The diff to 5.4.1 says so | patch |
| 9 | Setting `frameworkErrors` makes Fastify log `incoming request` for every bad URL, and the default branch logs no completion (blind, edge) | low | `fastify.js:643-646`; the default branch writes `reply.raw` | patch (comment that says why) |
| 10 | The query-string row never reaches `frameworkErrors`, and no case pairs a bad path with a query (blind) | low | `/statusx?q=/status/%E0` is a plain router 404 | patch |
| 11 | The "outside" test asserts no status codes and matches bodies with a loose regex; `/graphql` is absent (blind) | low | Test at diff :137-158 | patch |
| 12 | Router misses are tested with `GET` only; `HEAD`, `POST` and `OPTIONS` are not pinned (blind) | low | Probe: the miss catches every method | patch |
| 13 | A query handler imports a module in `src/shared/api/`, the dependency `no-command-query-to-api-deps` exists to stop, even though its patterns miss it (blind) | low | `resolve-organization-by-slug.handler.ts` imports `@/shared/api/public-surface` | patch (the message moves to `src/shared/domain/`) |
| 14 | AGENTS.md's router-404 pitfall (`maxParamLength`) and the bounded-surface convention do not mention the `/status` miss and bad-URL handling (blind) | low | AGENTS.md "Known pitfalls"; the fix edits agent-context | defer |
| 15 | The bad-URL 400 lacks Helmet's headers (blind) | low | Pre-existing: Fastify's default 400 had none either; the body is JSON | reject |
| 16 | Sprint status says `in-progress` while the spec says `in-review` (blind) | false | Step 5 syncs the sprint status to `review` | reject |
| 17 | The spec and the epic context are untracked (blind) | false | Withheld from reviewers by design and committed with the code, as in 9.12 | reject |

Loopback 1 (intent_gap, #1–#5): the code was stashed (`git stash list`: "4.1 pass-1"), and the diff kept at `/tmp/claude-1000/-home-sleipnir-projects-watchdog/ab18f6fa-4419-4766-8956-90039b266411/scratchpad/story-4-1.diff`. The frozen Approach (scoped not-found handler) and its out-of-scope reason for `//status` go back to the human.

Pass 2 (2026-10-18, after loopback 1): blind hunter, edge-case hunter, verification gap.

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 18 | The bare `/status` catch-all's rate limit is untested; the flood test sends only `/status/a/b` (verification) | medium | Pre-verified gap; each route has its own limiter bucket | patch |
| 19 | "Rationed like the page" is a bucket of the same size, not the page's bucket. Each route, and each automatic HEAD route, has its own `LocalStore` child (blind, edge, verification) | low | `@fastify/rate-limit` `index.js:172-179`, `store/LocalStore.js` `child`. ARCHITECTURE does not say so | patch (5.4.1 wording) |
| 20 | "Nothing outside `/status` changes" is untrue for logs. Setting `frameworkErrors` makes Fastify log `incoming request` for every malformed URL app-wide (blind, edge) | low | `fastify.js:643-646`. The code comment says so (row #9), and 5.4.1 does not | patch (5.4.1 wording) |
| 21 | A cross-origin preflight to a router miss (`OPTIONS /status/x/`) or to a malformed URL gets a non-2xx, so a conditional fetch of a miss is still opaque (blind, edge) | low | True, and pre-existing: master answered both 404/400 too. The matrix fixes `OPTIONS` misses at 404 | defer (story 4.5, which adds the next preflight) |
| 22 | The bad-URL 400 lacks Helmet's headers (blind) | low | carried: row #15 | reject |
| 23 | AGENTS.md is now stale (`PUBLIC_BY_DESIGN` list; router 404 pitfall) (blind) | low | carried: row #14; fixes to agent-context defer | defer (already recorded) |
| 24 | `isUnderStatus` does not decode `%73tatus`; untested `HEAD` of a malformed URL (blind) | low | Decoding unreserved escapes adds a branch for a target nobody sends. The `HEAD` case is a one-line test | patch (the `HEAD` case only); reject the decoding |
| 25 | `PUBLIC_PAGE_NOT_FOUND` is used only by `status-page`, so it belongs in that module's `domain/`; the import is aliased (blind) | low | True, but placement only: no caller diverges, and the spec's Code Map chose `shared/domain` | reject |
| 26 | Dead tuple column in the "outside" test; `DELETE`, `PUT` and `PATCH` misses unsent (blind) | low | Diff :164-172 and :89-97 | patch |
| 27 | The letter-case deferred entry's `target:` breaks the file's convention (blind) | low | `deferred-work.md:3-4` requires one epic or trigger | patch |
| 28 | The catch-all's `onSend` duplicates the page route's (blind) | low | They differ on purpose: only the page has a 304 branch | reject |
| 29 | The reviewed diff omits the spec and status files (blind) | false | Withheld from reviewers by design; committed with the code | reject |
| 30 | Malformed URLs under `/status` are not rationed, and each writes two `info` lines (edge) | low | Any unmatched path outside `/status` (`/api/nope`) is just as unrationed and logs as much. A limiter in `frameworkErrors` has no Fastify instance to build one from | reject |
| 31 | `isUnderStatus` strips any `scheme://` origin, while find-my-way strips only `http(s)` (edge) | low | The regex at diff :532. The only consequence is CORS headers on a 400; a one-token fix | patch |
| 32 | An error code other than the two would be answered as the async-constraint error (edge) | low | Fastify 5.7.2 passes only those two codes to `frameworkErrors` (`fastify.js:649`, `:680`) | reject |
| 33 | A body-bearing miss with a malformed JSON body answers 400/415, not the uniform miss (edge) | low | Body parsing precedes the handler. It still carries the public headers and no path, and nobody posts to a miss | reject |
| 34 | The `/graphql` "outside" row compares status, not body (edge) | low | Diff :170 | patch |

## Implementation Notes

**Pass 1, superseded by loopback 1 and stashed as `stash@{0}`:**

Constraint 11, each fix reverted one at a time against the new tests:
- Scoped `/status` not-found handler disabled: "gives a router miss under /status the uniform miss..." fails.
- `frameworkErrors` public branch disabled: "answers a malformed URL under /status/..." fails (integration and unit).
- `Retry-After` dropped from the exposed headers: the CORS test, the router-miss and bad-URL tests, and the 429 flow fail.
All restored afterwards; the suite passes.

Deviation worth knowing: the bad-URL 400 message is the fixed string `Bad Request` (so no path is echoed); outside `/status` the answers are written to `reply.raw` exactly as Fastify's defaults do.

Verified by the orchestrator, after adding `assertPublicHeaders(preflight.headers)` to the CORS test (the matrix's preflight row expects the new exposed headers): check clean; unit 266/266 with and without `.env`; integration 647/647 twice; e2e 4/4; auth schema in sync.

**Pass 2 (catch-all route, `frameworkErrors`):**

Constraint 11, each fix reverted one at a time:
- Catch-all routes pointed at another url: "gives a router miss under /status the uniform miss..." and "rations router misses like the page" fail.
- `frameworkErrors` public branch disabled: the integration and unit bad-URL tests and the `error-logging` bad-URL test fail.
- Path normalization (origin strip, slash collapse) removed: `isUnderStatus` unit test and the integration bad-URL test (`//status/%E0`) fail.
- `Retry-After` dropped from the exposed headers: the CORS test, router-miss, rationed-miss, bad-URL, 429-flow and unit tests fail.
- Pass 1's throwing `setNotFoundHandler` restored under `/status`: "keeps answering after a method the router does not know" fails.
All restored afterwards.


**Pass 2, after the review patches (rows #18, #19, #20, #24, #26, #27, #31, #34):**
- The implementer added a `HEAD` branch to `frameworkErrors`, because the new `HEAD /status/%E0` test showed a JSON body on a HEAD answer.
- Verified by the orchestrator: check clean; unit 265/265 with and without `.env`; e2e 4/4; auth schema in sync.
- Integration ran six times in full. The first run had **1 failure**; its output was not kept, so the test is unknown. The other five passed 650/650. The story's two suites (`public-surface-bounds`, `error-logging`) passed 20/20 alone five times. This matches the AGENTS.md clock-skew pattern on this machine, but that is not proven. A failure in CI would be real.
