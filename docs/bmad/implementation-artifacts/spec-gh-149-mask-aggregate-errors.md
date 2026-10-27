---
title: 'GH #149 — mask aggregate errors instead of treating them as validation'
type: 'bugfix'
created: '2026-10-27'
status: 'done'
baseline_commit: 'be12d15169a9483d94fb51d7569661a839f91cde'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `graphqlErrorFormatter` (`src/server/graphql-error-formatter.ts`) passes an error through unmasked when `isValidation` holds, and `isValidation` only asks whether the error has an `errors` array. A native `AggregateError` has one too. Node raises one when every address of a host refuses a connection, for example `ECONNREFUSED` on `127.0.0.1` and `::1`, and postgres.js forwards it unchanged. The anonymous `/graphql` endpoint therefore answered with each member's message, internal addresses and ports included. REST masks the same failure as a 500.

**Approach:** Recognise mercurius's own wrappers by what they are, not by their shape. That means the code `MER_ERR_GQL_VALIDATION` with every member a `GraphQLError`, and the code `MER_ERR_METHOD_NOT_ALLOWED`, whose only member is a fixed literal. Every other error, aggregates included, falls to the existing masked path: "Internal Server Error", a correlation id, and the original logged through `logFailure` at `error` with its stack.

## Boundaries & Constraints

**Always:**
- A validation pass-through needs `original.code === 'MER_ERR_GQL_VALIDATION'`, an `errors` array, and every member `instanceof GraphQLError`. mercurius 16.7.0 does not export the wrapper's class, so its code is the only identity it has. The members check refuses any non-GraphQL error that copies the code. mercurius and the app share one `graphql@16.12.0` instance, so `instanceof` holds.
- `original.code === 'MER_ERR_METHOD_NOT_ALLOWED'` also passes through. mercurius throws it for a mutation sent by `GET` (`index.js:524-526`), with one plain `Error` whose text is the fixed literal `Operation cannot be performed via a GET request`. Today it answers 405, and only because `isValidation` matches its `errors` array.
- Owner decision (2026-10-27): a `MER_ERR_GQL_VALIDATION` member may also be Fastify's own request-validation error, `code === 'FST_ERR_VALIDATION'` with a `validation` array. mercurius wraps it at `routes.js:137`. A `POST /graphql` with no body reaches it and answers 400 `body must be object` today, which `public-surface-bounds.integration.test.ts` ("changes nothing outside /status") pins. That keeps AGENTS.md's rule that Fastify's own 4xx refusals pass through.
- Any other member masks the wrapper. That includes the `MER_ERR_GQL_QUERY_DEPTH` errors mercurius would build from `queryDepth` (`index.js:509`), which this app does not configure. Turning `queryDepth` on later means revisiting this check.
- Every other pass-through rule stays exactly as it is: no `originalError`, an `ExceptionBase`, an `ErrorWithProps`.
- A masked aggregate answers like any masked error. The body is `Internal Server Error` with `extensions.correlationId`, the log line is at level 50 with the original's stack, and the status rules are unchanged.
- Validation, syntax and variable-coercion errors still reach the caller with their own messages and a 400.

**Never:**
- No change to `src/server/plugins/error-handler.ts`, to `logFailure`, or to `serializeError`. REST and the logs already behave correctly.
- Never `console.error`. Never copy an aggregate member's text into a message or a log `msg`.
- No edits to `docs/genesis/*` or `AGENTS.md`.

## I/O & Edge-Case Matrix

`AGG` is `new AggregateError([m1, m2])`, built the way Node builds it. Its `code` is `'ECONNREFUSED'` and its message is empty. `m1` is `connect ECONNREFUSED 10.20.30.40:6543` and `m2` is `connect ECONNREFUSED fd00::40:6543`. Each member carries `code`, `errno: -111`, `syscall: 'connect'`, `address` and `port: 6543`.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Anonymous page fails | `publicStatusRepository.listPublicServices` throws `AGG`; `publicStatusPage` over GraphQL | 500. The body is exactly the masked shape the existing test pins, with a correlation id | Logged at 50 with a stack under that id; `err.aggregateErrors` present |
| Same over REST | same fault; `GET /status/:slug` | 500 masked with a correlation id, as today | — |
| Authenticated resolver fails | signed-in cookie; `serviceRepository.list` throws `AGG`; `query { services { id } }` | 500 masked with a correlation id | Logged at 50 with a stack |
| Same over REST | same fault; `GET /api/v1/services` with the cookie | 500 masked with a correlation id | — |
| No leak, any of the four | the response bodies | none contains `10.20.30.40`, `fd00::40`, `6543`, `ECONNREFUSED` or `AggregateError` | — |
| Unknown field | `publicStatusPage(...) { nope }` | 400, `Cannot query field "nope"…` (existing test) | — |
| Bad argument type | `query { services(filter: 5) { id } }`, signed in | 400, message names `ServiceFilter` | — |
| Bad variable | `PAGE_QUERY` with `slug: {}` | 400, message starts `Variable "$slug" got invalid value` | — |
| Bodyless POST | `POST /graphql`, no body | 400, body `{"data":null,"errors":[{"message":"body must be object"}]}` (existing test) | — |
| GET mutation | `GET /graphql?query=mutation{__typename}` | 405, message `Operation cannot be performed via a GET request` | — |
| Fake validation code | the page throws an `Error` given `code: 'MER_ERR_GQL_VALIDATION'` and `errors: [m1]` | 500 masked; no `10.20.30.40` in the body | Logged at 50 |

</frozen-after-approval>

## Code Map

- `src/server/graphql-error-formatter.ts:96-98` -- `isValidation`, the only duck-typed check under `src/`. It is used at line 46. Lines 52-60 are the masked path to reuse unchanged. The header comment (lines 18-20) names "mercurius's validation wrapper, which carries a list of them", so update it to say how the wrapper is recognised.
- `node_modules/mercurius/lib/errors.js:128-132` -- `MER_ERR_GQL_VALIDATION` is `createError('MER_ERR_GQL_VALIDATION', 'Graphql validation error', 400)` and is not exported (`index.js:614` exports only `ErrorWithProps`). `index.js` sets `err.errors` to `GraphQLError`s at ~454 (cached), ~474 (syntax), ~499 (validation) and ~544 (variables), all checked to be `GraphQLError`s. `lib/routes.js:184` hands the formatter `{ errors: [toGraphQLError(error)] }`, so the wrapper is `originalError`. Batched queries (`routes.js:402`) and subscriptions use the same formatter.
- `node_modules/mercurius/lib/errors.js:46-50` -- the default formatter expands any `originalError.errors` into separate entries. That is how both addresses reached the body. A masked error's `originalError` is an `InternalServerErrorException`, which has no `errors`.
- Node 24 `net`, with autoSelectFamily on by default, raises `AggregateError` (code `ECONNREFUSED`, message `''`) when every resolved address fails. postgres.js forwards it unchanged (`node_modules/postgres/src/connection.js:381-388`).
- `src/server/plugins/error-handler.ts:90-97` -- REST already masks it as a 500. `serializeError` (`src/shared/db/sql-debug.ts:180-185`) logs the members under `aggregateErrors`, scrubbed, and `sql-debug.spec.ts:448-477` covers that.
- `src/server/graphql-error-formatter.integration.test.ts` -- extend this file. Its patterns are `withBrokenPage` (it patches the DI singleton `publicStatusRepository.listPublicServices` and restores it in `finally`), the `logLines` capture, `gqlResponse(app, query, { variables, cookie })` and `signUpWithOrg(app, tag)`, which returns a `cookie`. The existing cases stay unedited.
- `src/modules/service/queries/list-services/list-services.handler.ts` -- calls `serviceRepository.list(tx, filter)` on the DI singleton `serviceRepository`. Patch it the way `withBrokenPage` patches the page. `services(filter: ServiceFilter): [Service!]!` is non-null, so a masked failure answers 500. Its REST route is `GET /api/v1/services` (`list-services.route.ts:16`); the cookie alone is enough. `serviceRepository` is an awilix singleton, so patching `.list` reaches both surfaces.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/graphql-error-formatter.integration.test.ts` -- Add an `AGG` builder and a generic `withBroken(repositoryName, method, error, run)` helper, keeping `withBrokenPage` as it is. Cover every Matrix row, and assert the four no-leak bodies by string search. Run it against the current formatter and confirm the leak rows fail. -- reproduce first.
- [x] `src/server/graphql-error-formatter.ts` -- Replace `isValidation` with the two explicit checks from Boundaries, and update its doc comment and the header lines that describe the wrapper. -- the fix.

**Acceptance Criteria:**
- Given the current formatter, when the new tests run, then the AGG GraphQL rows and the fake-code row fail, and the failing run is recorded in Implementation Notes, not committed.
- Given the fix, when the integration file runs, then every Matrix row and every existing case pass.
- Given the fix, when `isValidation` is restored to `Array.isArray(errors)`, then the AGG GraphQL rows fail.
- Given the fix, when the members check is dropped (code only), then the fake-code row fails.
- Given the fix, when the `MER_ERR_METHOD_NOT_ALLOWED` pass-through is dropped, then the GET mutation row fails.
- Given the fix, when `FST_ERR_VALIDATION` members are no longer accepted, then the bodyless POST row fails.

## Implementation Notes

- Reproduction (not committed): against the old `Array.isArray(errors)` check, the new file fails 3 tests. Those are the aggregate on the anonymous page, the aggregate on the authenticated resolver, and the fake validation code, and each body carries the members' addresses. The REST rows, the bad argument, bad variable, GET mutation and bodyless POST rows already pass, as expected.
- First pass broke `public-surface-bounds.integration.test.ts` "changes nothing outside /status": a bodyless `POST /graphql` became a masked 500. Its `MER_ERR_GQL_VALIDATION` member is Fastify's `FST_ERR_VALIDATION`, which the frozen Boundaries had wrongly said no request reaches. The owner decided to keep the 400 (Boundaries updated). `isRequestValidation` accepts such a member, and the formatter file pins the bodyless POST row itself.
- Sabotages, each run against `graphql-error-formatter.integration.test.ts` and then restored:
  - old `Array.isArray` check: 3 fail (anonymous aggregate, authenticated aggregate, fake code)
  - code only, no members check: 1 fails (fake code)
  - no `MER_ERR_METHOD_NOT_ALLOWED` pass-through: 1 fails (GET mutation 405)
  - `FST_ERR_VALIDATION` members refused: 1 fails (bodyless POST 400)
- Review patches (triage #3-#9): `MER_ERR_METHOD_NOT_ALLOWED` now needs its one literal member, `MER_ERR_GQL_VALIDATION` needs a non-empty list, `statusOf` logs a 4xx wrapper at its own status (405), the comments were corrected, and the tests were tightened. Sabotages after the patch, each failing at least one test: old check (4 fail); no members check; no METHOD pass-through; FST refused; code check deleted; empty-list guard dropped; METHOD on code alone (1 each).
- Verification: `pnpm run check` clean (11 Biome warnings, pre-existing, other files). Unit 478/478 with `.env` and without it. Integration 862/862. e2e 12/12. `auth:schema:check` in sync. The first integration attempt failed `public-surface-bounds` "changes nothing outside /status" 3 times (once in the suite, twice alone). It was a real defect of pass 1, not clock flake, and was fixed by the owner's decision above.

## Spec Change Log

## Review Triage Log

| # | Layer | Finding | Verdict | Evidence | Route |
|---|-------|---------|---------|----------|-------|
| 1 | blind, edge | `GET /graphql` with malformed `variables`/`extensions` JSON: mercurius's `tryJSONParse` (`routes.js:142-150`) stamps `MER_ERR_GQL_VALIDATION` on a bare `SyntaxError` with no `errors`, which is masked as a 500 and logged at error | medium | Probe confirmed the 500. Baseline masks it too (no `errors` array), so this diff did not cause it | defer (D1) |
| 2 | edge | Unwrapped Fastify refusals on `/graphql` (malformed JSON body, `text/xml`, `{"query":123}`) answer a masked 500 | medium | Probe confirmed it. Pre-existing for the same reason as #1; same root cause, the formatter not recognising a request refusal that has no `errors` list | defer (D1) |
| 3 | blind, edge | `MER_ERR_METHOD_NOT_ALLOWED` passes on its code alone, and mercurius's formatter expands any members verbatim | low | Edge probe: a resolver error copying the code leaked `10.20.30.40`. No code copies it today, but the fix is a direct check of the one literal member | patch |
| 4 | blind, edge, verification gap | An empty `errors` list passes (`[].every` is true), and no test separates the code check from the members check | medium | Verification-gap layer, pre-verified: deleting the code check passes every test. `new AggregateError([])` (e.g. `Promise.any([])`) is realistic | patch |
| 5 | blind, edge | `statusOf` logs the 405 GET mutation as 400 | low | `statusOf` falls to `return 400` for a non-`ExceptionBase`, non-`ErrorWithProps` error | patch |
| 6 | blind | Header comment omits the `FST_ERR_VALIDATION` member and files the wrapper under "no `originalError`" | low | Lines 17-23 against `routes.js:184`, where the wrapper is `originalError` | patch |
| 7 | blind, edge | The `queryDepth` caveat lives only in the spec | low | `isValidation`'s doc comment is where the person enabling it would look; one sentence | patch |
| 8 | blind | `assertMaskedGraphql` does not pin the exact body the Matrix asks for | low | The Matrix row says "exactly the masked shape the existing test pins"; the helper checks three fields | patch |
| 9 | blind, edge | The log assertions only check that `aggregateErrors` exists, never member count or `msg` | low | Boundaries Never: no member text in a log `msg`; untested | patch |
| 10 | blind | `assertMaskedRest` does not check the REST log or deep-equal the body | low | REST is unchanged by this diff, and 'answers the same failure over REST the same way' deep-equals that body | reject |
| 11 | blind | The pass-through tests don't check log levels | low | Pass-through logging is unchanged except the 405 status, which #5's patch tests | reject |
| 12 | blind | No unit test for `isValidation` | low | The integration file covers every branch, and CI's database job runs it | reject |
| 13 | blind | `withBroken` duplicates `withBrokenPage` | low | Spec Tasks keep `withBrokenPage` and the existing cases unedited; the duplication is harmless | reject |
| 14 | blind | A `GraphQLError` member wrapping an internal fault passes | low | Only reachable by an error that deliberately copies mercurius's code; nothing does, and #4's patch adds a no-code `GraphQLError` aggregate case | reject |
| 15 | edge | Spec claim: the METHOD_NOT_ALLOWED member is never inspected | low | Closed by #3's patch | patch (with #3) |
| 16 | edge | Spec Approach understates the accepted members | low | The fix would edit this build's spec | reject |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean
- `pnpm run test` -- expected: all pass, also with `.env` moved aside
- `pnpm run test:integration` -- expected: all pass. Only postgres, mailpit and migrate are up
- `pnpm run test:e2e` and `pnpm run auth:schema:check` -- expected: pass
