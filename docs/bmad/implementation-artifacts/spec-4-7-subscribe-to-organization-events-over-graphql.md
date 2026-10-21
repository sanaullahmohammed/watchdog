---
title: 'Story 4.7 — Subscribe to organization events over GraphQL'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: 'ed091cc52f96e07760dfa338013dc6b076ff0dff'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The admin dashboard has no live channel. An operator sees incident, service and monitor changes only after a manual refresh, and drafts never reach any client.

**Approach:** Turn on mercurius subscriptions over WebSocket and add `Subscription.organizationEvents` in `src/server/realtime/`. It authenticates from the upgrade request, subscribes to the hub's admin channel for the active organization, and forwards each signal (ARCHITECTURE 5.5, decided 2026-10-18). Queries and mutations stay HTTP-only.

**Decisions (owner, 2026-10-21):**
- ARCHITECTURE 5.5 gets one sentence: queries and mutations over the WebSocket are refused, so HTTP `/graphql` stays their only transport. No other `docs/genesis` edit.
- A member with a valid session but no membership, or a role off the ladder, is refused with `UNAUTHENTICATED` and is not rationed. Only an upgrade without a valid session counts against the anonymous limit (5.4.1, 5.5). This amends the story's third AC, which also lists a role off the ladder.
- The spec stays whole (about 2,300 tokens).

**Decisions after review pass 1 (owner, 2026-10-21):**
- The 10 s timer runs from the upgrade until the socket's first subscription is accepted, not until `connection_init`. A socket with no accepted subscription by then is closed with 4408, whether it never initialised, initialised and never subscribed, or was refused.
- A masked internal failure closes the socket with 4500, not 4401, so the client reconnects rather than treating its session as invalid. Only `UNAUTHENTICATED` closes with 4401.
- A socket holds at most 10 live subscriptions (`MAX_SUBSCRIPTIONS_PER_SOCKET`, a module constant). An 11th is refused with `ErrorWithProps('Too many subscriptions', { code: 'TOO_MANY_SUBSCRIPTIONS' })`, and the socket and its live subscriptions stay open.

## Boundaries & Constraints

**Always:**
- SDL: `organizationEvents: OrganizationEvent!`, where `OrganizationEvent { eventName: String!, aggregateType: String!, aggregateId: String!, occurredAt: String! }`. A hub event maps field for field. A `resync` maps to `{ eventName: 'resync', aggregateType: 'organization', aggregateId: <orgId>, occurredAt: <now ISO> }`, the convention `uptime.rollup_refreshed` already uses. `closed` completes the iterator.
- Authentication reads the upgrade's own headers, copied once at the upgrade and never again. Mercurius merges `connection_init` payload headers into `request.headers` at every subscription start, and it re-runs `subscription.context` on every `connection_init` (`subscription-connection.js:152-157, 191-194, 294-299`). So a cookie sent in a payload never authenticates, not even after a second `connection_init`.
- The `subscribe:` property's own body calls `resolveOrganizationContext`, inline, so `authenticated-surface.spec.ts` sees it. A null context, or an `UnknownOrganizationRoleError` (logged), is refused with `ErrorWithProps('Authentication required', { code: 'UNAUTHENTICATED' })`. Mercurius sends a `subscribe` throw raw through `sendError` (`:333-335, :433`), not through our `errorFormatter`. So `subscribe` catches every other error, logs it through `logFailure` with a correlation id, and throws a masked `ErrorWithProps('Internal Server Error', { code: 'INTERNAL_SERVER_ERROR', correlationId })`. After an `UNAUTHENTICATED` refusal the socket is closed with 4401, and after a masked failure with 4500, in each case after the error message has been sent.
- The `Origin` check is mercurius's two-argument `verifyClient(info, cb)`. With one argument, ws answers 401. It runs on the raw header, after the `onRequest` hooks. Trusted means equal to the origin of `BETTER_AUTH_URL`, or to an entry of Better Auth's `trustedOrigins` if one is ever configured. A missing or untrusted origin answers `cb(false, 403)` for every upgrade, with or without a cookie. So an anonymous cross-site upgrade is rationed first and then refused. Behind a proxy, `BETTER_AUTH_URL` must be the public origin.
- The existing `onRequest` hook rations the upgrade, because the upgrade is `GET /graphql` on the same route. It is not changed. A test proves it.
- A socket with no accepted subscription within 10 s of its upgrade (`SUBSCRIPTION_DEADLINE_MS`, a module constant) is closed with 4408. Otherwise an anonymous caller could hold one socket per rationed request indefinitely.
- One socket resolves who is subscribing at most once: every `subscribe` on it shares the first resolution. A `subscribe` whose id is already live on the socket closes it with 4409, as graphql-transport-ws requires, so no iterator is orphaned.
- `fullWsTransport` stays unset, so a query or mutation over the socket gets an `error` message from `MER_ERR_GQL_SUBSCRIPTION_INVALID_OPERATION` ("Invalid operation: query"). Mercurius also accepts the legacy `graphql-ws` subprotocol. That is fine, because the same handler runs.
- The iterator:
  - Its queue is bounded by a module constant, `MAX_QUEUED_SIGNALS = 100`. On overflow, the queue becomes one `resync`, and new events queue behind it. A `resync` while one is already queued is dropped.
  - `closed` ends the iterator after the queued signals have been read.
  - `return()` is idempotent, resolves a pending `next()` with `done`, and unsubscribes. It also handles a `closed` delivered during the `subscribeAdmin` call itself.
- `app.close()` does not wait on a client. `@fastify/websocket`'s `preClose` closes each socket gracefully, and the hub's `preClose` ends every iterator. A further `preClose`, registered after them, terminates any socket that has not finished closing, so a client that never answers the close frame cannot hold `close()`.
- Integration tests run with only postgres, mailpit and migrate up.

**Never:**
- No `setNotFoundHandler`, no migration, no new dependency. Tests use Node 24's global `WebSocket`. It sends `Cookie` and `Origin` only when they are passed as `new WebSocket(url, { protocols: ['graphql-transport-ws'], headers })`.
- No per-user or per-IP cap on concurrent authenticated sockets. That is a deferred-work entry, targeting Epic 8.
- No access re-check timer and no `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`. Those belong to 4.8.
- No cursor, no replay, no per-event payload beyond the four fields.
- No edits to `AGENTS.md`. The only `docs/genesis` edit is the 5.5 sentence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Event | Valid session, trusted Origin. A bridged event of the active org, admin-only included | `{ eventName, aggregateType, aggregateId, occurredAt }` arrives |
| Resync | `app.realtimeHub.resync()` | Exactly one `resync` event |
| Isolation | Subscribed in org A. Org B's events | Nothing arrives |
| No session | No cookie, a junk cookie, or an expired one | `UNAUTHENTICATED`. Repeated upgrades reach 429 on the upgrade, with `Retry-After`, read from a raw `http` upgrade (a 429 may arrive as ECONNRESET, so retry the read) |
| Non-member / bad role | Valid session. No membership, or a role off the ladder | `UNAUTHENTICATED`. Not rationed |
| Payload cookie | No upgrade cookie. The session cookie is sent in the `connection_init` payload, then subscribe, then a second `connection_init`, then subscribe again | `UNAUTHENTICATED` both times |
| Masked failure | `resolveOrganizationContext` throws a plain `Error` | `INTERNAL_SERVER_ERROR` with a correlation id, and not the original message, which is logged. Then a close with 4500 |
| Refusal closes | Any `UNAUTHENTICATED` refusal above | The `error` message arrives, then a close with 4401 |
| Deadline | Upgrade succeeds, then no `connection_init`, or `connection_init` and no `subscribe`, within 10 s | Closed with 4408. The test waits it out, with no injection seam |
| Deadline cleared | A socket whose subscription was accepted, observed past 10 s | Still open, and still sent events |
| Per-socket cap | 10 live subscriptions, then an 11th | The 11th gets `TOO_MANY_SUBSCRIPTIONS`. The 10 stay live, and the socket stays open |
| Duplicate id | A `subscribe` reusing a live id | Closed with 4409. The hub keeps no subscription for that socket |
| One resolution | An anonymous socket pipelines several `subscribe` messages in one frame batch | Each is refused, and the session is resolved once |
| Origin | `Origin` missing or `http://evil.test`, with a valid cookie, and without a cookie while the anonymous bucket has room | The upgrade is refused with 403 |
| Query over WS | `{ services { id } }` or a mutation on the socket | An `error` message, "Invalid operation: query" (or "mutation"). No resolver runs |
| Overflow | 101 signals queued, none read, then one more event | The reads are one `resync`, then that event (unit spec) |
| Close | An open subscription, and a raw upgraded socket that never answers a close frame. Then `app.close()` | The subscription is sent `complete`, then a close with 1001. The raw socket is cut off. `close()` resolves within 2 s |
| Gate (Constraint 11) | Remove the `resolveOrganizationContext` call from `subscribe` | The no-session test and `authenticated-surface.spec.ts` fail. Recorded |

</frozen-after-approval>

## Code Map

- `src/server/index.ts:21-29` -- mercurius registration. Add `subscription: { verifyClient, context }`. `verifyClient(info, cb)` copies `info.req.headers` into a `WeakMap` keyed by `info.req`, before any merge can happen. `context(socket, request)` returns `{ upgradeHeaders: <that copy>, socket }`, and clears the init timer. Its result is spread into the resolver context. Augment `MercuriusContext` with both fields. The init timer starts on `fastify.websocketServer`'s `connection` event. Register the new resolver explicitly after the modules AutoLoad (`:85-100`), because that AutoLoad reads only `src/modules`. The `onRequest` rationing hook (`:48-68`) stays as is.
- `src/server/anonymous-graphql.ts` -- matches `routeOptions.url === '/graphql'` and resolves the session. With subscriptions on, mercurius's GET route carries `wsHandler`, so the upgrade passes through it. Prove it, do not change it.
- `src/server/plugins/gql.ts` -- loads every `*.graphql-schema.ts` under `src/`, so the new SDL file is found with no change. `throwOnConflict`.
- `src/server/auth/organization-context.ts:19, 113-136` -- `ORG_ROLES` is owner, admin and member, and all are admitted. `resolveOrganizationContext(headers)` returns a context or null, and throws `UnknownOrganizationRoleError` for a role off the ladder.
- `src/config/auth-env.ts:32` `baseUrl`, and `src/server/auth/auth.ts:80` (no `trustedOrigins` today) -- the inputs to the Origin check.
- `src/shared/realtime/realtime-hub.ts:35-45` -- `subscribeAdmin(orgId, fn) => unsubscribe` delivers every bridged event, `resync` and `closed`. Delivery is synchronous. A closed hub sends `closed` during the subscribe call.
- `src/server/plugins/realtime.ts:28` -- `hub.close()` in `preClose`. Do not move it.
- `node_modules/mercurius/lib/subscription-connection.js`:
  - `:254-264` refuses a non-subscription operation unless `fullWsTransport`.
  - `:333-335` sends a `subscribe` error raw, through `sendError` (`:433`). Only per-event `next` payloads go through `errorFormatter` (`:350`).
  - `:338` `for await`s the iterator. `:379` and `:400` call `return()` on `complete` and on socket close.
- `subscription.js:64-73` -- mercurius registers `@fastify/websocket` with `verifyClient` and creates a default, unused in-memory pubsub, which is harmless. `@fastify/websocket` `index.js:213` registers its graceful `preClose`, and `:52` decorates `websocketServer`.
- `src/server/error-logging.ts` `logFailure(log, error, statusCode, correlationId)` -- logs the masked failure (500, at `error`) and every refusal (401, at `warn`).
- `subscription-connection.js:331-335` logs a `subscribe` that returns errors at `error` before sending it. A refusal must therefore not be thrown from `subscribe`. Instead, `subscribe` returns an iterator whose first `next()` rejects with the refusal. The rejection leaves mercurius's `for await` (`:338`) for `handleGQLStart(...).catch(sendError)` (`:89-91`), which sends the same `error` message and logs nothing. `graphql`'s `mapAsyncIterator` passes a source rejection through. Each refusal is logged once, by us, through `logFailure`.
- `subscription-connection.js:331` `subscriptionIters.set(id, …)` overwrites a live id. Track live ids per socket in the resolver, and refuse a reused one (4409).
- Pass 1's code is kept in a stash: `git stash list` shows it as "story 4.7 pass 1 (review loopback 1)". Start from it. See the Spec Change Log.
- Pattern: `open-public-status-stream.public.route.ts:139-227` shows the subscribe/cleanup handling, including a `closed` delivered during the subscribe. `list-monitors.resolver.ts:15-22` shows the refusal.
- `src/shared/api/contract/authenticated-surface.spec.ts:35, 92-98, 212-215` -- reads only `src/modules`. Add `src/server/realtime` as a second root, labelled per root. `resolverOperations` (`:175-210`) already knows `Subscription` and searches the whole field subtree.
- `api-surface-parity.spec.ts` -- scans `src/modules` slices only. No change.
- `src/shared/testing/graphql.ts` -- add the subscription client. `tenant.ts`: `signUpWithOrg`, `TEST_ORIGIN`. Invite plus accept: `src/server/auth/auth.integration.test.ts:347-364`. A role off the ladder: update `"member"."role"` by SQL. `fixtures.ts:417` `openMonitorDraft`. `notifications.ts`: `subscribeForOrg(...).settle(app)` and `notifyRaw`. Its sentinel (`aggregateType: 'test.sentinel'`) reaches subscribers, so filter it out.
- 429 pattern: `public-surface-bounds.integration.test.ts:447-462` (its own app, flood up to `max+2`).
- E2E: `tests/support/server.ts` already uses `listen: true`. `common-hooks.ts` listens on `127.0.0.1:<port>`. Pair to copy: `tests/status-page/public-status-stream.{feature,steps.ts}`.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/auth/trusted-origin.ts` and `.spec.ts` -- pure `isTrustedOrigin(origin: string | undefined, trusted: readonly string[])`. It must not import `auth-env`, which needs a `.env` at import. `index.ts` builds the list from the config. The unit spec covers a match, a different port or scheme, a missing value, `null`, and a malformed value.
- [x] `src/server/realtime/organization-events.graphql-schema.ts` -- `type Subscription { organizationEvents: OrganizationEvent! }` plus the type.
- [x] `src/server/realtime/hub-iterator.ts` and `.spec.ts` -- `adminSignals(hub, orgId)` returns an `AsyncIterableIterator<OrganizationEvent>`, following the iterator rules in Boundaries. Unit-test every one: mapping, resync, a coalesced resync, overflow then an event, queued signals then `closed`, `closed` during the subscribe, a pending `next()` resolved by `return()`, and an idempotent `return()`.
- [x] `src/server/realtime/organization-events.resolver.ts` -- `defineResolvers({ Subscription: { organizationEvents: { subscribe, resolve } } })`. `subscribe` resolves the context once per socket from `ctx.upgradeHeaders`. It then refuses, masks or caps per Boundaries, through a rejecting iterator (Code Map). It tracks the subscription's id on its socket, clears the socket's deadline on the first acceptance, and returns `adminSignals(ctx.app.realtimeHub, orgId)`, untracked when that iterator ends. `resolve: (payload) => payload`, because the default resolver would read `payload.organizationEvents`.
- [x] `src/server/index.ts` -- the `subscription` option, the deadline timer (started in the `wsHandler` wrapper and exposed to the resolver through the context, not cleared at `connection_init`), the terminating `preClose`, and the explicit registration.
- [x] `authenticated-surface.spec.ts` -- add the second root.
- [x] `src/shared/testing/graphql.ts` -- `openSubscription(baseUrl, { cookie?, origin?, payload? })`, speaking `graphql-transport-ws`, and `upgradeStatus(baseUrl, headers)`, a raw `http` upgrade that returns the status code, because `WebSocket` hides it. Every wait in them (open, upgrade, next message) rejects after a deadline, so a hung server fails a test rather than stalling CI.
- [x] `src/server/realtime/organization-events.integration.test.ts` -- every matrix row. Build with `{ listen: true }`, `app.listen({ port: 0, host: '127.0.0.1' })`, and use the test's own orgs. Run the 429 flood in its own app. Close test last. Close every client before its app. Await `app.eventBus.drain()` before `settle` or the first assertion. No unscoped worker pass. Build the 429 app while the suite's app is still open. Run the deadline test with an accepted subscription alongside it, so the 10 s wait covers both rows. The rationing test asserts whatever its last step does, or drops it.
- [x] `tests/admin/organization-events.{feature,steps.ts}` -- over a real socket: `incident.created` from a declared incident, `incident.draft_created` from `openMonitorDraft`, and `service.status_changed`. Step text must not collide with existing steps.
- [x] `docs/genesis/ARCHITECTURE.md` 5.5 -- the one sentence from the Decisions.
- [x] `deferred-work.md` -- add one entry: there is no cap on concurrent authenticated sockets per user or per IP. Target: Epic 8.
- [x] Gate mutation, as in the matrix. Record the result in Implementation Notes.

**Acceptance Criteria:**
- Given `authenticated-surface.spec.ts`, when a `Subscription` field under `src/server/realtime/` does not call `resolveOrganizationContext`, then the spec fails.
- Given `pnpm run check`, unit (with and without `.env`), integration and e2e, when run, then all pass.

## Implementation Notes

- **Gate (Constraint 11).** With `subscribe`'s `resolveOrganizationContext` call replaced by a fixed context, `authenticated-surface.spec.ts` failed, naming `Subscription.organizationEvents (server/realtime/organization-events.resolver.ts)`, and the integration test "refuses an upgrade with no cookie" failed (no `error` message within 5 s). Restored; both pass.
- **Further mutations, each failing its test, then restored.** `subscribe` reading `ctx.reply.request.headers`, and `context` returning `{ ...request.headers }` instead of the upgrade copy: both fail the payload-cookie test. Without `socket.terminate()` in the closing `preClose`, `app.close()` took 30.0 s (ws's close timeout) and the close test failed.
- **Where the code map did not hold.** mercurius registers `@fastify/websocket` inside its own non-`fastify-plugin` child contexts (`routes` -> `subscription`), so `fastify.websocketServer` is undefined at the root and `@fastify/websocket`'s `preClose` runs after every root `preClose`, not before. So `src/server/index.ts` adds a root `onRoute` hook, before mercurius is registered, that wraps the `/graphql` `wsHandler` (child contexts inherit the hook and run it before `@fastify/websocket`'s own). The wrapper starts the 4408 init timer and tracks the socket; it runs in the same callback that follows ws's `connection` event. The closing `preClose`, registered after the hub's, sends each tracked socket a 1001 close and terminates any that has not closed within `CLOSE_GRACE_MS` (500 ms). `@fastify/websocket`'s own `preClose` then finds nothing open.
- **The 4401 close** is scheduled with `setImmediate` from the refusal: mercurius turns the throw into the `error` message within microtasks, so the message is queued ahead of the close frame. The payload-cookie test pipelines `subscribe`, `connection_init`, `subscribe` in one tick so both refusals are answered before the close.
- **Origin.** `isTrustedOrigin` is an exact match on the serialized origin. Better Auth's `trustedOrigins` is read only when it is an array; a function or wildcard entry would need handling in `trustedUpgradeOrigins` (`src/server/index.ts`). None is configured.
- **Logging (pass 1 risk, fixed in pass 2).** Pass 1 threw refusals from `subscribe`, and mercurius logged each at `error` (`subscription-connection.js:333-334`). Pass 2 returns a rejecting iterator instead (Code Map), so each refusal is logged once, by `logFailure`: 401 at `warn` (the unknown role's own message, naming the membership), 429 (`TOO_MANY_SUBSCRIPTIONS`) at `info`, the masked failure at `error` with its stack. A refusal is logged once per socket resolution, not once per pipelined `subscribe`.
- **Pass 2 (loopback 1).** `src/server/realtime/organization-events.resolver.ts` was rewritten around a per-socket state (a `WeakMap` keyed by the socket, per app): one shared admission promise, a map of live ids (taken at entry, so a pipelined duplicate is caught too) and the set of accepted subscriptions. Order in `subscribe`: duplicate id (close 4409 synchronously, return an ended iterator, so mercurius sees the socket closing and never overwrites the live one) -> shared admission -> refusal (4401 or 4500, scheduled with `setImmediate` from the refusal iterator's `next()`) -> socket closed while waiting (ended iterator, nothing joins the hub) -> cap -> accept (clear the deadline, `adminSignals` wrapped to untrack on end or `return()`). `src/server/index.ts`: `SUBSCRIPTION_DEADLINE_MS` replaces the init timeout, `context` no longer stops it and instead exposes `clearSubscriptionDeadline`; `MercuriusContext` also gains mercurius's `id`. Helpers: every wait in `openSubscription` and `rawUpgrade` now has a 5 s deadline, and the client gains `waitClosed(ms)`.
- **Pass 2 mutations, each failing the named test, then restored.** No deadline clear on accept: the deadline test (its accepted subscription closed with 4408). Deadline cleared in `context` (pass 1's rule): the deadline test (the initialised idle socket stayed open). Resolution per `subscribe` (`=` for `??=`): the one-resolution test (3 lookups) and the cap test. No duplicate check: the 4409 test. No cap: the cap test. Refusal thrown from `subscribe`: the three no-session tests (an `error`-level line naming the refusal). Masked failure closing with 4401: the masked-failure test. The gate (Constraint 11) re-run on pass 2 code: `authenticated-surface.spec.ts` names `Subscription.organizationEvents (server/realtime/organization-events.resolver.ts)`, and every refusal and delivery test fails.

- **Review pass 2 patches (triage #22-29).**
  - The 4409 close uses the fixed reason "Subscriber already exists".
  - `verifyClient`'s 403 is logged at `warn`.
  - Refusals log through the upgrade request's logger.
  - The doc comment counts the rationing hook's lookup.
  - The closing `preClose` yields one `setImmediate` before closing.
  - New tests:
    - `complete` frees the id;
    - `complete` frees a cap slot;
    - a 200-character reused id still gets 4409;
    - the socket closes while admission is pending.
  - The test bounds come from `MAX_SUBSCRIPTIONS_PER_SOCKET` and the exported `SUBSCRIPTION_DEADLINE_MS`.
  - Mutations, each restored:
    - with the id in the 4409 reason, the 200-character test fails;
    - without the closed-while-pending branch, its test fails.
  - Orchestrator verification after the patches:
    - `pnpm run check` is clean (11 pre-existing warnings).
    - Unit: 338 of 338, with and without `.env`.
    - Integration: 718 of 718.
    - e2e: 10 of 10.
    - Auth schema: in sync.
  - Deferrals #13, #14 and #30 were appended to `deferred-work.md`.

## Spec Change Log

- **Loopback 1 (2026-10-21), after review pass 1.**
  - Triggered by: triage #1-3 (intent gaps, which the owner settled as the Decisions after review pass 1) and #4-12 (bad_spec).
  - Amended: the frozen deadline, close-code and cap rules, and their matrix rows. Also, outside the frozen block: once-per-socket resolution, duplicate-id refusal, refusal through a rejecting iterator, helper deadlines, and the close-order, cross-site and deadline-cleared tests.
  - Known-bad states avoided:
    - an anonymous socket held open forever after `connection_init`;
    - a transient failure telling the client its session is invalid;
    - unbounded subscriptions per socket;
    - an orphaned hub subscription after a reused id;
    - N session lookups per rationed upgrade;
    - an `error`-level log line per refusal.
  - KEEP from pass 1 (stash "story 4.7 pass 1 (review loopback 1)"):
    - `hub-iterator.ts` and its unit spec, unchanged;
    - `trusted-origin.ts` and its spec;
    - the SDL file;
    - the upgrade-header `WeakMap` captured in `verifyClient`;
    - the root `onRoute` hook that wraps the `/graphql` `wsHandler`;
    - the terminating `preClose` after the hub's, with a 500 ms grace;
    - the explicit resolver registration;
    - the two-root `authenticated-surface.spec.ts`;
    - the subscription helpers, the e2e feature and steps, the ARCHITECTURE 5.5 sentence, and the deferred-work entry;
    - the integration suite's structure (one listening app, own orgs, a separate 429 app, the close test last).
  - Change only what the amendments require.

## Review Triage Log

Pass 1 (2026-10-21). Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | An anonymous socket that sends `connection_init` and never subscribes stays open indefinitely (B, E) | high | `context` clears the 4408 timer on every `connection_init`, and authentication happens only in `subscribe`. One rationed upgrade buys a socket held forever, which is the exact case the Boundaries' timer exists to prevent. The frozen rule names `connection_init` as the trigger, and more than one fix is possible | intent_gap |
| 2 | A masked internal failure closes the socket with 4401, telling the client its session is invalid (B, E) | medium | `closeAfterRefusal` runs in every catch branch. The frozen matrix row "Refusal closes / any refusal above" includes the masked failure, so changing the code needs the owner | intent_gap |
| 3 | One socket can hold any number of subscriptions, each a hub subscription with a queue of up to 100 (E) | medium | Nothing counts subscriptions per socket. The Never line defers only a per-user or per-IP socket cap | intent_gap |
| 4 | A reused subscription id orphans the earlier iterator, which keeps its hub subscription after the socket closes (E) | medium | `subscription-connection.js:331` `subscriptionIters.set(id, …)` overwrites. `:400` returns only the map's iterators on close, and the orphan's `for await` never ends | bad_spec |
| 5 | Pipelined subscribes from one anonymous socket each run a session lookup before the deferred 4401 close (E) | medium | `subscribe` calls `resolveOrganizationContext` per message. The close is `setImmediate`, so one frame batch of N subscribes costs N lookups for one rationed request | bad_spec |
| 6 | A refusal of a later subscription closes the socket under an earlier live one (E) | low | Real only when resolution differs between subscribes on one socket. Resolved by #5's once-per-socket resolution | bad_spec (with #5) |
| 7 | mercurius logs every `subscribe` refusal at `error` (B, V) | medium | `subscription-connection.js:333-334` logs `subIter.errors` before rethrowing. AGENTS.md: a 401 logs at `warn`. An anonymous caller causes one line per rationed upgrade | bad_spec |
| 8 | Nothing proves `connection_init` cancels the 4408 timer (V, B) | medium | Pre-verified. Deleting the `clearTimeout` keeps every test green, and every live subscription in the tests ends within 10 s | bad_spec (test, re-derived with #1) |
| 9 | The close test asserts neither `complete` before the close frame nor code 1001 (V, B, E) | medium | Pre-verified. It checks only the elapsed time and that both sockets closed | bad_spec (test) |
| 10 | `rawUpgrade` and `openSubscription`'s open wait have no deadline, so a hung server stalls CI (B) | low | `src/shared/testing/graphql.ts`. `node:test`'s timeout is infinite. A direct addition | bad_spec (test) |
| 11 | No test covers an anonymous cross-site upgrade getting 403 while the bucket has room (B) | low | The 403 test sends only `operator.cookie`. Direct addition | bad_spec (test) |
| 12 | The rationing test ends with a `subscribe` that asserts nothing (B) | low | A direct deletion or assertion | bad_spec (test) |
| 13 | Dead peers are never detected: no keep-alive or ping (B) | medium | `keepAlive` is unset. A vanished client holds its socket, hub subscription and queue until the OS's TCP timeout. The spec settles no keep-alive policy | defer |
| 14 | ARCHITECTURE 5.5 says an upgrade without a session "is refused", while the refusal comes at `subscribe` (B) | low | The upgrade gets 101 and `connection_ack`. Editing `docs/genesis` needs the owner, who allowed one sentence | defer |
| 15 | The upgrade's trusted origins ignore `BETTER_AUTH_TRUSTED_ORIGINS` and wildcard or function entries (B, E) | low | `better-auth/dist/context/helpers.mjs:83` reads it from `process.env`. Nothing in this project sets it, and `src/config` is the only sanctioned source | reject |
| 16 | `authenticated-surface.spec.ts` scans two hard-coded roots (B) | low | A surface file elsewhere would also not be loaded by either autoloader. The fix (fail on surface files anywhere else) adds a branch for an unlikely case | reject |
| 17 | Test helpers are duplicated between the integration and e2e suites (B) | low | True. It causes drift only, with no runtime harm | reject |
| 18 | The 4401 close relies on mercurius sending the error within microtasks (B) | low | No `preSubscriptionExecution` hook is configured. Recorded in Implementation Notes | reject |
| 19 | Story status differs between the spec and `sprint-status.yaml`, and 4.6's done is bundled (B) | false | Step 3 sets `in-progress`, and step 5 moves it on. 4.6 → done was the owner's instruction for this branch | reject |
| 20 | The contract spec counts a `resolveOrganizationContext` call anywhere in the field, `resolve` included (E) | low | This is the existing rule for every resolver, not new in this change | reject |
| 21 | `SubscriptionClient.send` takes a protocol message, not a query as the spec's task said (E) | low | A test-helper signature. No caller misuses it | reject |

Pass 2 (2026-10-21), after loopback 1. Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 22 | Nothing tests that a client `complete` frees the subscription's id and its place under the cap (V, B) | medium | Pre-verified. Dropping `untilEnded`'s `onEnd` keeps every test green. No test sends a client `complete` | patch (test) |
| 23 | A reused id longer than about 90 bytes makes the 4409 close reason exceed 123 bytes, so ws throws after setting CLOSING. No close frame is sent and the socket stays stuck (E) | medium | `ws/lib/websocket.js:321` sets CLOSING before `sender.close`, and `sender.js:198` throws `RangeError`. Later `close()` calls return early on CLOSING. The reason echoes the client's id | patch |
| 24 | `verifyClient`'s 403 is not logged (B) | medium | The `next(false, 403)` branch logs nothing, and ws writes the 403 itself. AGENTS.md: a 403 logs at `warn`. A cross-site attempt, or a misconfigured `BETTER_AUTH_URL`, leaves no trace | patch |
| 25 | Refusals log on the app logger, without the upgrade request's id (B) | low | `admit` and the cap branch use `ctx.app.log`. mercurius hands the request in as `ctx.reply.request`. A direct substitution | patch |
| 26 | "One session lookup per socket" is two for an upgrade with a cookie (B) | low | The rationing hook's `resolveActor` also runs on the upgrade. The claim is in the resolver's doc comment. Reword it | patch |
| 27 | The branch for a socket closed while admission was pending is untested (B) | low | Deleting it keeps every test green. A direct test addition (delay the lookup, close the client, assert the hub holds nothing) | patch (test) |
| 28 | The closing `preClose` relies on microtask hops for `complete` to precede the 1001 close (E) | low | The test passes today, but the order depends on how many awaits mercurius's loop takes. One `setImmediate` yield before closing removes the dependency | patch |
| 29 | Tests hard-code the cap (10, 11) and the deadline (9 s, 15 s) instead of deriving them from the constants (B) | low | `MAX_SUBSCRIPTIONS_PER_SOCKET` is exported. `SUBSCRIPTION_DEADLINE_MS` is module-private. A direct change | patch (test) |
| 30 | Story 4.8's re-check must also reset a socket's cached admission, or later subscribes stay admitted after access is lost (B) | medium | `state.admission ??= …` lives for the socket's lifetime. Nothing hands this to 4.8 | defer (4.8) |
| 31 | The pass-1 deferrals #13 and #14 are not in `deferred-work.md` (B) | false | Defers are appended when step 4 processes them, which this pass does | reject |
| 32 | The Code Map still describes pass-1 wiring (B) | low | The fix is an edit to this build's spec. Implementation Notes record the actual wiring | reject |
| 33 | The deadline is never re-armed once a socket's subscriptions all end (B) | low | The owner's decision clears it at the first acceptance. Only an authenticated socket gets there, and the per-user cap entry (Epic 8) covers the bound | reject |
| 34 | The legacy `graphql-ws` subprotocol is untested (B) | low | Both protocols reach the same `handleGQLStart` through `protocolMessageTypes`. A second suite would only duplicate it | reject |
| 35 | Tests that rely on the server closing a client have no `finally` close (B) | low | Matters only after an earlier assertion has already failed | reject |
| 36 | `SubscriptionClient.next()` waits out its timeout after the socket closed (B, E) | low | A slower, less clear failure message. No wrong outcome | reject |
| 37 | Trusted origins are not validated at boot (B) | low | `BETTER_AUTH_URL` has a valid default, and a bad value fails every Better Auth request too | reject |
| 38 | A `complete` sent while a subscribe awaits admission is lost, and the subscription then streams (E) | low | True: mercurius's `handleGQLComplete` finds no iterator yet. Needs a client that stops within milliseconds of starting, and the fix needs a mercurius hook | reject |
| 39 | A client at the cap can keep sending refused subscribes, each logged at `info` (E) | low | Authenticated only. Bounded by the deferred per-user cap (Epic 8) | reject |
| 40 | The subscription over HTTP POST skips `subscribe` and its auth check (E) | low | graphql's `execute` runs `resolve` on mercurius's empty root value, so `eventName: String!` fails non-null and `data` is null. Nothing is exposed, and the HTTP request is already rationed | reject |

## Design Notes

The refusal happens at `subscribe`, not at `onConnect`. `onConnect` can only answer a generic `Forbidden` connection error (`subscription-connection.js:175`), while a throw in `subscribe` is formatted as `UNAUTHENTICATED`. It also keeps the `resolveOrganizationContext` call in the resolver, where the contract spec looks. The upgrade itself is already rationed by the HTTP hook, so a socket that never subscribes still costs an anonymous caller one request.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean (pre-existing warnings only)
- `pnpm run test` (and with `.env` moved aside) -- expected: all pass
- `pnpm run test:integration` (only postgres, mailpit, migrate up) -- expected: all pass
- `pnpm run test:e2e` -- expected: all scenarios pass
- `pnpm run auth:schema:check` -- expected: in sync
