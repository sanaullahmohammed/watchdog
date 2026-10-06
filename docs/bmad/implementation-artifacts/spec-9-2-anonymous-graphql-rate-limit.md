---
title: 'Story 9.2 — The anonymous GraphQL limit holds whatever cookie arrives'
type: 'bugfix'
created: '2026-10-06'
status: 'done'
baseline_commit: 'a5ad45cd8b3526bec4e9837bdd25d88b0c377a75'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The anonymous GraphQL rate limit (`src/server/index.ts`, `onRequest` hook) applies only to `POST` requests whose URL starts with `/graphql` and that carry no `Cookie` header. Audit F-02 showed that `Cookie: junk=cookie` skips an exhausted bucket. Investigation found three more ways round it, each answering 200 today: `GET /graphql?query=…`, `HEAD /graphql?query=…`, and `POST //graphql` (accepted because `ignoreDuplicateSlashes` is on).

**Approach:** Decide "anonymous" by resolving the session, never by the presence of a header (ARCHITECTURE §5.4.1). A request to the GraphQL route is anonymous unless it carries a valid Better Auth session, and every anonymous request to that route is rationed, whatever its method or path spelling.

## Boundaries & Constraints

**Always:**
- Match the route, not the raw URL: `request.routeOptions.url === '/graphql'`, which Fastify has already normalised in `onRequest` (probed: `GET`, `HEAD` and `//graphql` all report `/graphql`). Every method on that route is covered.
- No `Cookie` header means anonymous, with no lookup. A cookie triggers one session lookup through the existing `resolveActor` path in `src/server/auth/organization-context.ts` (`auth.api.getSession`). A null result means anonymous.
- Keep the existing traps: read `isExceeded`, not `isAllowed`, and throw `TooManyRequestsException` with the same headers.
- A valid operator session is still never rationed.

**Never:**
- No change to `/status/:orgSlug`'s route-level limit, to the limits' values, or to `trustProxy` (F-18).
- No removal of the GET transport. It stays available, and bounded.
- No rate limiting of authenticated callers. Open sign-up makes that a separate question, recorded as deferred work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Audit reproduction | Bucket exhausted from one IP; next `POST /graphql` carries `Cookie: junk=cookie` | 429, `Retry-After`; the resolver is not reached | `TooManyRequestsException` |
| Signed-out session | Bucket exhausted; cookie from a session that has signed out | 429 | same |
| GET transport | Bucket exhausted; `GET /graphql?query={__typename}` | 429 | same |
| HEAD transport | Bucket exhausted; `HEAD /graphql?query=…` | 429 | same |
| Double slash | Bucket exhausted; `POST //graphql` | 429 | same |
| Valid operator | Bucket exhausted; valid session cookie | Not 429 (existing test, kept) | — |
| Junk cookie under the limit | Bucket not exhausted; `Cookie: junk=cookie` | Answers normally: `publicStatusPage` works, an admin query gets `UNAUTHENTICATED` | — |
| Session lookup fails | `getSession` throws, e.g. the database is unreachable | Fails closed: treated as anonymous and counted against the anonymous bucket, so during an auth outage even an operator can receive 429 once that bucket is spent; otherwise the request continues | Logged at `warn`, not raised |

Decided at planning (2026-10-06):
- GET and HEAD stay available and are bounded, not refused. The story allowed either; bounding keeps the API unchanged.
- Any valid session is exempt, as ARCHITECTURE §5.4.1 says, whether or not it has an organization.
- A valid session is looked up twice per GraphQL request, once by the limiter and once by the resolver. Accepted: the lookup is idempotent, and Better Auth's `Set-Cookie` from a refresh is not forwarded from the limiter's call (spec review, 2026-10-06).

</frozen-after-approval>

## Code Map

- `src/server/index.ts:29-70` -- the rate-limit registration, `limitAnonymous = createRateLimit(...)`, and the hook to change. Its comment at 29-32 states the old cookie rule; rewrite it.
- `src/server/auth/organization-context.ts:53-68` -- `resolveActor(headers)` wraps `auth.api.getSession({ headers: fromNodeHeaders(headers) })` and returns null for no session. It is already exported; reuse it unchanged. Do not call Better Auth directly from the hook. Probe: junk and forged cookies return null without throwing; one lookup is about one DB round-trip (no `cookieCache` is configured).
- `src/modules/status-page/public-surface-bounds.integration.test.ts:159-218` -- 'rations anonymous callers by IP, on both surfaces'. It builds an isolated `limited = buildApp()` and has a `flood(send)` helper (max + 2 sends, from `env.publicSurface.rateLimit.max`, default 120). The operator exemption is at 206-214. Buckets live per app instance, so each new exhausted-bucket case floods its own fresh `buildApp()`. A signed-out cookie: sign in, `POST /api/auth/sign-out` with `origin: TEST_ORIGIN`, then reuse the old cookie.
- `src/shared/testing/tenant.ts` -- `signUpWithOrg`, `TEST_ORIGIN`, `captureCookie`.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/anonymous-graphql.ts` (new) -- `isRationedGraphqlRequest(request, resolve = resolveActor)`, returning true when `routeOptions.url` is `/graphql` and the request has no cookie, or has one that `resolve` maps to null or that makes it throw (logged at `warn` through the request's logger). It is a plain function, not a Fastify plugin, so `@fastify/autoload` never loads it (AGENTS.md pitfall). Unit-test it in `anonymous-graphql.spec.ts` with a stub resolver. Cases: another route is not rationed; no cookie is rationed and the stub is not called; a junk cookie (stub returns null) is rationed; a valid session is not rationed; a stub that throws is rationed. This covers the lookup-failure row.
- [x] `src/server/index.ts` -- the hook calls `isRationedGraphqlRequest` instead of the inline cookie test. Rewrite the comment above it to state the rule.
- [x] `src/modules/status-page/public-surface-bounds.integration.test.ts` -- cover each row except lookup failure, which the unit spec covers. One flood per fresh `buildApp()` may serve several exhausted-bucket rows (junk cookie, signed-out cookie, GET, HEAD, `//graphql`), since once spent the bucket answers all of them, so the cases need not each flood. Assert 429 and `retry-after` on each. Assert the message matches `/Rate limit exceeded, retry in \d+ seconds/` wherever there is a body, whatever its shape (GraphQL `errors[0].message` or REST `message`). For `HEAD`, assert status and header only. The junk-cookie-under-the-limit row uses its own un-flooded app.
- [x] Other integration files -- confirm none sends more than the limit (120) of anonymous or junk-cookie GraphQL requests to one app instance, now that GET, HEAD and junk-cookie traffic counts. Record the result in Implementation Notes.
- [x] `AGENTS.md` -- in the "anonymous surface is bounded" bullet, after "a rate limit by client IP", add: "on `/graphql` for every request without a valid session, decided by resolving the session, never by the presence of a `Cookie` header, and matched on the route, so `GET`, `HEAD` and `//graphql` are bounded too". `docs/bmad/planning-artifacts/Architecture.md` (constraints): "A `Cookie` header is not a session. Anything that treats a caller as authenticated resolves the session first."
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append one entry in the existing `source_spec` / `summary` / `evidence` format: authenticated callers are never rationed, and sign-up is open, so anyone can mint a session that exempts them; decide on an authenticated limit before production exposure.

**Acceptance Criteria:**
- Given an operator's GraphQL traffic, when it exceeds the anonymous limit, then none of it is rationed, as today.
- Given `pnpm run test:integration`, when it runs, then every existing GraphQL test that sends a valid cookie still passes.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `ResolveActor` returns `unknown \| null` and the gate tests `=== null`, so a resolver returning `undefined` would fail open (blind) | low | `resolveActor` returns null today; a type error would catch a future change | patch |
| 2 | The signed-out test has no positive control: the cookie is never shown to be exempt before sign-out (blind) | medium | Test asserts only the post-sign-out 429 | patch |
| 3 | No test sends a forged `better-auth.session_token` with a bad signature; `junk=cookie` is not a session cookie at all (blind) | low | Better Auth's signed-cookie check is a separate path (`session.mjs:40`) | patch |
| 4 | Any cookie triggers a lookup before the bucket is checked, so rationed requests still cost a session query (blind, edge, gap) | low | `session.mjs:40,47`: an unsigned or forged cookie returns null before any query; only a validly signed token, such as a signed-out one, reaches the database | defer |
| 5 | A lookup that hangs stalls `onRequest`, so the limiter never runs (edge) | low | Such a request hangs in its resolver anyway; not a bypass | reject |
| 6 | The route match hard-codes `/graphql`, with nothing tying it to mercurius's path (blind) | low | A path change would make the existing flood test fail, since it would no longer get 429 | reject |
| 7 | The session is resolved twice per request (blind, gap) | low | Accepted and recorded in the frozen block | reject |
| 8 | A second `buildApp()` in one process answered `publicStatusPage` with "Command type … is not registered" (blind) | maybe-false (medium if true) | Observed by the implementer; settle by building two apps in one process and fetching the page from the second | defer |
| 9 | The sprint status says in-progress while the spec says in-review (blind) | false | Step 5 sets `review` at presentation | reject |
| 10 | `refused` accepts either error shape, hiding a regression (blind) | low | Every POST and GET 429 on the route comes back in mercurius shape | patch |
| 11 | The junk-cookie-under-the-limit test does not check the admin status, and `JSON.stringify(undefined)` can throw (blind) | low | Test body | patch |
| 12 | A valid session with no organization is untested end to end (blind) | low | The unit stub covers it; `signUpWithOrg` always creates an organization | reject |
| 13 | A database outage turns into one warn per request (blind) | low | Expected during an outage; the spec chose `warn` | reject |
| 14 | The unit spec fakes the request `as never`, so typing is off (blind) | low | `anonymous-graphql.spec.ts` | patch |
| 15 | The AGENTS.md bullet's `/graphql` parenthetical reads as applying to every new route (blind) | low | Bullet wording | defer (agent-context file) |
| 16 | The hook comment repeats the function docstring (blind) | low | `index.ts` comment against `anonymous-graphql.ts` docblock | patch |
| 17 | The signed-out `signUpWithOrg` call sits outside `try`/`finally`, so a failure leaks the user row (edge) | low | Leaks only when the test itself fails, and only in the test database | reject |
| 18 | The junk-cookie-under-the-limit row uses the shared app, against the spec (edge) | low | A deliberate deviation recorded in Implementation Notes, caused by #8. The shared app's bucket sees about five requests against 120 | reject |

## Implementation Notes

- **CI fix after commit `3278142` (2026-10-06).** CI's unit job failed: `anonymous-graphql.spec.ts` imported `anonymous-graphql.ts`, which imported `resolveActor` at runtime and so loaded the Better Auth instance, whose `auth-env.ts` requires `DATABASE_URL` and `BETTER_AUTH_SECRET` at import. Local runs passed only because `.env` supplied both. Fix: the module takes the lookup as a required parameter (a type-only import), and `src/server/index.ts` passes `resolveActor`. Reproduced and verified by running `pnpm run test` with `.env` moved aside: before 110/111, after 115/115.

- Audit of other integration files: the nine files that touch `/graphql` send valid-cookie or a handful of anonymous requests per app instance, none near 120; `test:integration` passed twice.
- The junk-cookie-under-the-limit case uses the file's shared, never-flooded `app` rather than a new `buildApp()`: a second app in the same process answered `publicStatusPage` with 'Command type ... is not registered' (the CQRS registration appears process-global), so a fresh instance cannot serve a page.

## Verification

**Commands:**
- `pnpm run check` -- passes.
- `pnpm run test` -- passes.
- `pnpm run test:integration` -- passes, run twice, since bucket timing can flake.
- `pnpm run auth:schema:check` -- in sync.
