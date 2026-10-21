---
title: 'Story 4.8 — Close a subscription when access is lost'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: 'de07a6403dc2087b02143032ebd94394a5e1b321'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A 4.7 subscription is checked only when it opens. An operator who signs out, whose session expires, or who is removed from the organization keeps receiving its events for as long as the socket lives. ARCHITECTURE 5.5 promises disconnection within `ADMIN_SUBSCRIPTION_RECHECK_SECONDS` (default 60).

**Approach:** Once a socket has its first accepted subscription, the resolver re-checks it every `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`, for as long as the socket lives. The re-check reads the session from the upgrade's own headers, and checks membership of the organization the socket was admitted for, not the session's active one. When access is lost, the socket closes, and every subscription on it ends with it. This also covers the 4.7 deferral: a socket's cached admission never outlives access by more than one interval.

## Boundaries & Constraints

**Always:**
- The session lookup bypasses Better Auth's cookie cache and never refreshes the session: `getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })`. Otherwise a long-lived socket would keep extending its own session.
- The lookup calls `auth.api.getSession(...)` through the property at call time, so tests can swap it, and passes `fromNodeHeaders(upgradeHeaders)`.
- Access holds while the session still belongs to the admitted `userId` and `findOrgRole(admittedOrgId, userId)` is a known role. Switching the active organization changes nothing. `findOrgRole` reads Better Auth's `"member"` table on the plain connection, which is allowed, because it is not a tenant table (`organization-context.ts:5-13`).
- On lost access (no session, a different user, no membership, or an `UnknownOrganizationRoleError`):
  - log through `logFailure` at 401 (`warn`);
  - close the socket with 4401 ("Unauthorized").
- On a failed lookup (any other throw), or a lookup still unsettled after `min(interval, 10 s)`:
  - log through `logFailure` at 500 (`error`, with a correlation id). The error is the top-level argument, as `admit` passes it;
  - close with 4500. This fails closed.
- Close reasons reuse the fixed strings "Unauthorized" and "Internal error". The guarantee is that nothing is sent after the close frame. Events published between the loss of access and the next re-check may still arrive, because "within one interval" is the bound.
- Timer rules:
  - Each re-check is scheduled after the previous one finishes, so two never overlap.
  - The timer is `unref`'d and stops when the socket closes.
  - `socket.readyState !== OPEN` is checked after the lookup settles and again in its `catch`, before anything is logged or closed. A socket that is closing or closed is never logged, closed or rescheduled. This covers `app.close()`, whose `preClose` moves sockets to CLOSING while a lookup may still be in flight and the pools end after it.
  - The whole re-check body is wrapped, so nothing throws an unhandled rejection.
- Config: `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`, default 60, minimum 1, maximum 2_147_483 (the `setTimeout` cap, as the other `*_SECONDS` settings use).
  - Declared in a small module (`src/config/realtime-env.ts`), as `check-results-env.ts` is, so a unit spec can test its default and bounds.
  - Exposed through `env.ts`, and documented in `.env.example`.
  - `env.ts` spreads `...realtimeEnvProperties`. `.env.example` gets a commented `# ADMIN_SUBSCRIPTION_RECHECK_SECONDS=60` with one comment line.
  - The resolver reads `env.realtime.adminSubscriptionRecheckSeconds` each time it schedules a re-check, never once at registration.
- Integration tests run with only postgres, mailpit and migrate up.

**Never:**
- No `setNotFoundHandler`, no migration, and no edits to `docs/genesis` or `AGENTS.md`. ARCHITECTURE 5.5 already describes this re-check.
- No change to how a socket is admitted, to its close codes, or to the 4.7 limits.
- No unscoped worker pass in tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Sign-out | Live subscription. The operator calls `POST /api/auth/sign-out` | Closed with 4401 within one interval. No event of the org arrives after the close |
| Expiry | The session's `expiresAt` is set in the past by SQL | Closed with 4401 within one interval |
| Removal | The owner removes the member through `POST /api/auth/organization/remove-member` | Closed with 4401 within one interval. No event arrives after the close |
| Off-ladder role | The membership's role is set to an unknown role by SQL | Closed with 4401 |
| Active-org switch | A's owner adds the operator with `addMember`. The operator calls `set-active` to A and subscribes, then calls `set-active` to B, their own org | Still open after several intervals, and still sent A's events. Then A's owner removes them (`organizationId: A`): closed with 4401 |
| Still allowed | Nothing changes. The session's `expiresAt` and `updatedAt` are first moved by SQL so it is past Better Auth's `updateAge` (1 day) and would be refreshed by a plain `getSession` | Still open after several intervals, and the session row is unchanged |
| Lookup fails | `getSession` throws during a re-check | Closed with 4500, and an `error` line with a correlation id is logged |
| Lookup hangs | `getSession` never settles during a re-check | Closed with 4500 after `min(interval, 10 s)`, and logged |
| Idle socket | Every subscription on the socket was completed, then access is lost | The socket is still closed, so a later subscribe cannot reuse the cached admission |
| Closing app | `app.close()` while a re-check is held in its lookup, and the lookup is then rejected | `close()` resolves. The held re-check logs nothing, closes nothing and throws nothing |
| Gate (Constraint 11) | A throwaway edit makes each re-check a no-op | The removal test fails (its close never comes). The edit is reverted, and the spec records the result |

</frozen-after-approval>

## Code Map

- `src/server/realtime/organization-events.resolver.ts`:
  - `Admission` (`:62`) is `{ kind: 'admitted', orgId }`. Add `userId`. `admit` (`:89`) drops `context.userId` today.
  - `SocketState` (`:67`) is per socket, in a per-app `WeakMap`.
  - Start the re-check where the first subscription is accepted, beside `state.accepted.add` and `ctx.clearSubscriptionDeadline` (`:276-277`), if none is running.
  - Stop it on `socket.once('close')`. `logOf(ctx)` (`:80`) is the upgrade request's logger, so capture it at start.
  - Close directly with `socket.close(code, reason)`. Keep reasons fixed and short (under 123 bytes).
- `src/server/auth/organization-context.ts`:
  - `resolveActor` (`:53`) calls `getSession` with no query options. Leave it as is: admission and the rationing hook use it.
  - Add a lookup for the re-check with the two query options. `findOrgRole(orgId, userId)` (`:88`) is exported, runs without RLS, and throws `UnknownOrganizationRoleError`.
- `src/server/index.ts` -- `SubscriptionSocket` (`:28-33`) has `once('close')`. The closing `preClose` (`:308-332`) needs no change.
- `src/server/auth/auth.ts:77-102` -- no `session` block, so the cookie cache is off today. The `query` options are insurance against it being turned on.
- `node_modules/better-auth/dist/api/routes/session.mjs:170-183` -- `disableRefresh` skips `updateSession`. An expired session returns null and deletes its row.
- Better Auth endpoints:
  - sign-out deletes the session row;
  - `organization/remove-member` takes `{ memberIdOrEmail, organizationId }` and deletes the member row, but leaves another user's `activeOrganizationId` set;
  - `organization/set-active` takes `{ organizationId }`.
- `src/config/env.ts:50-64, 130-141` -- the `PUBLIC_STREAM_*` pattern. Add a `realtime` group, for example `env.realtime.adminSubscriptionRecheckSeconds`. `env` is a mutable object, and a test may set and restore the value in-process. `.env.example:58-67` shows the commented-default format. Pattern for the unit spec: `src/config/check-results-env.ts` and `.spec.ts`.
- Tests:
  - Patterns: `src/server/realtime/organization-events.integration.test.ts`. Copy what is needed: `open`, `liveSubscription`, `settle`, `eventOf`, the `getSession` hold (`:643-675`), `countAdminSubscriptions`, and the log capture. They are file-local.
  - `src/shared/testing/graphql.ts`: `openSubscription`, and the client's `closed` and `waitClosed`.
  - `src/shared/testing/tenant.ts`: `signUpWithOrg`, `TEST_ORIGIN`.
  - Invite and accept: `src/server/auth/auth.integration.test.ts:347-365`.
  - Second org and `setActive`: `auth.integration.test.ts:196-209`.
  - Sign-out: `public-surface-bounds.integration.test.ts:544-551`.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/realtime-env.ts` and `.spec.ts` -- the property. The spec covers the default 60, 1, the maximum, and refuses 0 and a fraction.
- [x] `src/config/env.ts` and `.env.example` -- the setting and the `realtime` group.
- [x] `src/server/auth/organization-context.ts` -- `stillHasAccess(headers, { userId, orgId })`, which returns `true` or `false`, maps an unknown role to `false`, and lets other errors throw.
- [x] `src/server/realtime/organization-events.resolver.ts` -- `userId` on `Admission`, plus the re-check per Boundaries. Update the doc comment.
- [x] `src/shared/testing/tenant.ts` -- `addMember(app, owner: { cookie, orgId }, invitee: { cookie, email })`: invite, then accept, asserting 200 for each, and returning the member id. Use it in the new suite only.
- [x] `src/server/realtime/organization-events-access.integration.test.ts` -- every matrix row:
  - Set the interval to 1 s in `before` and restore it in `after`, even if `before` fails.
  - A fake `getSession` tells a re-check apart by `query?.disableRefresh === true`.
  - Use one listening app and the test's own orgs.
  - "Within one interval" means a close within interval plus 2 s.
  - After each close, `settle` the org and assert that no message arrived after the close.
  - Close every client before the app.
- [x] Gate mutation, as in the matrix. Record it in Implementation Notes.
- [x] `deferred-work.md` -- mark the 4.7 #30 entry (cached admission, `deferred-work.md:287-290`) resolved by 4.8.

**Acceptance Criteria:**
- Given `pnpm run check`, unit (with and without `.env`), integration and e2e, when run, then all pass.

## Implementation Notes

- `stillHasAccess` (`organization-context.ts`) treats a session whose `userId` differs from the admitted one, or no session, as `false`, maps `UnknownOrganizationRoleError` to `false`, and lets anything else throw. The resolver logs lost access as `Subscription access lost` at 401 (`warn`, no stack) and a failed or hung lookup at 500 (`error`, with `err` and a correlation id). A hung lookup rejects with `The access re-check did not settle in <ms>ms`.
- The re-check starts once per socket (`SocketState.rechecking`), beside the first `state.accepted.add`, and reads the interval each time it schedules and each time it computes the lookup deadline.
- Gate mutation (Constraint 11), 2026-10-21: a throwaway edit made each re-check reschedule itself and return before its lookup. The removal test then failed: `Error: the close of ws://127.0.0.1:46711/graphql did not settle within 3000ms`. The edit was reverted (file restored from a copy; `grep` confirms it is gone) and the suite passes again.
- Review fixes, 2026-10-21: the lookup deadline is `recheckLookupDeadlineMs` in `src/server/realtime/access-recheck.ts`, apart from the resolver so its unit spec needs no `.env`. Re-check lines go through a child logger carrying `userId` and `orgId`. A throw from the re-check's own logging or close terminates the socket. The stated bound is one interval plus the next lookup, cut off at min(interval, 10 s). New tests, each checked against a throwaway mutation that was then reverted: one loop per socket (with the `rechecking` guard removed: "10 re-checks in 4 intervals"), and a held lookup answering no session after the client closed (with the open-state check after the lookup removed: "a closed socket is never logged"). The keep-open test now waits for four re-checks and has a control session that a plain `getSession` refreshes.
- Verification, 2026-10-21: `pnpm run check` clean (11 pre-existing `noExplicitAny` warnings, none in changed files); `pnpm run test` 342/342 with and without `.env`; `pnpm run test:integration` 728/728 with only postgres and mailpit running (first run, no reruns needed); the new suite alone 10/10; `pnpm run test:e2e` 10 scenarios passed; `pnpm run auth:schema:check` in sync.

- Orchestrator verification after the review patches (2026-10-21):
  - `pnpm run check` is clean (11 pre-existing warnings).
  - Unit: 345 of 345, with and without `.env`.
  - Integration: 730 of 730, with only postgres and mailpit up.
  - e2e: 10 of 10.
  - Auth schema: in sync.
  - Deferrals #9 and #10 were appended to `deferred-work.md`.

## Spec Change Log

- Planning (2026-10-21): beyond the story's file list, the spec adds `src/config/realtime-env.ts` and its spec (the `check-results-env.ts` pattern), a `tenant.ts` helper, the integration file, and the deferred-work update. All of them are needed for the story's verification.

## Review Triage Log

Pass 1 (2026-10-21). Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The 10 s cap on a hung lookup is never tested; at a 1 s interval `min(interval, 10 s)` is always the interval (V, B) | medium | Pre-verified. Replacing the `min` with `intervalMs` keeps every test green. At the 60 s default the cap is the bound that applies | patch (pure helper + unit spec) |
| 2 | Nothing tests that a socket runs one re-check loop, not one per subscription (V) | medium | Pre-verified. Dropping `!state.rechecking` keeps every test green. Every access test opens one subscription | patch (test) |
| 3 | The open-state check after a successful lookup is never exercised (V) | low | Pre-verified. The close test's held lookup rejects, so only the `catch` path runs. Resolving it to `false` instead is a direct test variant | patch (test) |
| 4 | Comments and the deferred note claim a close "within one interval", but the bound is the interval plus the next lookup's time (B, E) | medium | Each re-check is scheduled after the previous lookup settles, as the frozen rule requires, so the close comes up to `min(interval, 10 s)` after the interval. The resolver doc, the `realtime-env.ts` doc and `deferred-work.md` state the stronger claim | patch (wording) |
| 5 | A throw from `logFailure` or `socket.close` inside a re-check is swallowed, leaving the socket open and never re-checked (B) | low | `recheck().catch(() => {})`. Unlikely with fixed codes and reasons, but the fix is direct: terminate the socket in that catch | patch |
| 6 | The "never refreshes its session" test has no control proving a plain lookup would refresh that row (B) | medium | If Better Auth's `updateAge` default changed, the test would pass vacuously. A control on a second session is a direct addition | patch (test) |
| 7 | The lost-access log line names no user, organization or reason (B) | low | `logFailure(log, new Error('Subscription access lost'), 401, …)`. A child logger carrying `{ userId, orgId }` is a direct change | patch |
| 8 | The keep-open test's `calls >= 3` returns when the third re-check starts, so only two completed re-checks are proven (E) | low | `organization-events-access.integration.test.ts`. Use `>= 4` | patch (test) |
| 9 | Sockets accepted together re-check in lockstep, and a transient slow lookup closes all of them with 4500 together; at a 1 s interval the lookup budget is 1 s (B, E) | medium | No jitter, and the deadline is tied to the interval. Jitter or a retry before closing is a policy the frozen rules do not settle | defer |
| 10 | ARCHITECTURE 5.5 says the active organization is re-checked, but the story's AC keeps the admitted organization across a switch (B) | low | `ARCHITECTURE.md:450`. The AC owns the behaviour. Changing `docs/genesis` needs the owner | defer |
| 11 | A re-check close has no terminate fallback for a client that never answers the close frame (B) | low | ws holds CLOSING until its own close timeout (30 s), and sends nothing in CLOSING. Bounded | reject |
| 12 | The "different user" branch of `stillHasAccess` is untested (B) | low | A session cookie's token cannot change users, so the branch is defensive. "Constraint 11" is the epics file's story-level rule | reject |
| 13 | The spec and sprint statuses disagree, and the 4.7 #30 deferral is marked resolved before review (B) | false | Step 3 sets `in-progress`, and step 5 moves it on. The resolution note is part of this change and is reviewed with it | reject |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean (pre-existing warnings only)
- `pnpm run test` (and with `.env` moved aside) -- expected: all pass
- `pnpm run test:integration` (only postgres, mailpit, migrate up) -- expected: all pass
- `pnpm run test:e2e` -- expected: all scenarios pass
- `pnpm run auth:schema:check` -- expected: in sync
