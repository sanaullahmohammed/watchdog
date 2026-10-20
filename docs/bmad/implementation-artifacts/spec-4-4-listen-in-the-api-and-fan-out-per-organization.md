---
title: 'Story 4.4 — Listen in the api and fan out per organization'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: 'ecca6d13341008df0aa6262e180f5dd13c4acde4'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 4.3 sends every bridged event on `watchdog_events`, but nothing in the api hears it. Streams (4.5-4.6) and admin subscriptions (4.7-4.8) need per-organization signals that include changes made by the worker.

**Approach:** The api opens one `LISTEN` on its own dedicated connection. It validates each notification and hands it to an in-memory hub. The hub delivers to that organization's admin subscribers, and to its public subscribers only when the name is whitelisted. On re-listen after a lost connection, every subscriber gets `resync`. The worker never listens.

**Decisions (owner, 2026-10-20):**
- ARCHITECTURE records the listener before the code lands:
  - 5.2 diagram: the worker subscriber is "when needed".
  - 5.4: one paragraph after the sketch covering the dedicated connection, drop-and-warn, and resync on re-listen.
  - :199 and :795: name the listener connection.
- The spec stays whole (about 2,400 tokens). The hub and the listener are not split.

## Boundaries & Constraints

**Always:**
- The public whitelist is exactly DOMAIN's "Public" and "Public, draft-gated" events, which is ARCHITECTURE 5.4's 18 `PUBLIC_EVENT_NAMES`.
- Drop a notification and log it at `warn` when it is not JSON, has a `version` other than 1, names something outside `BRIDGED_EVENT_NAMES`, or has an `orgId` that fails `assertValidBetterAuthOrgId`. The listener keeps running.
- A subscriber that throws or rejects is logged at `error`, as a top-level `err`. Delivery to the others continues.
- The hub hears only `LISTEN`, never the in-process bus, so the api's own events arrive once.
- `app.close()` first ends every hub subscriber by sending `{ kind: 'closed' }`. It then unlistens and ends the dedicated connection. The entrypoint closes the shared pool after `app.close()`, so this comes first.
- Listening is off by default in `buildApp`. `src/api.ts` turns it on. The worker does not.

**Never:**
- No `setNotFoundHandler`. No migration. No new env var. No edit to `AGENTS.md`.
- In `docs/genesis`, only the ARCHITECTURE passages named in the decisions change. DOMAIN does not change.
- No page composition, coalescing, stream or GraphQL subscription. Those belong to 4.5-4.8.
- Integration tests run with only postgres, mailpit and migrate up.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Two orgs | Org A and org B subscribed. A NOTIFY for A is sent from the test's pool connection | A's admin subscribers get it. A's public subscribers get it only if whitelisted. B gets nothing |
| Malformed | Non-JSON, `version: 2`, `monitor.created`, `orgId: 'a b'` | Each is dropped with one `warn`. A valid notification sent afterwards is delivered |
| Throwing subscriber | First subscriber throws, second does not | The second still receives. One `error` log |
| Reconnect | The listener's backend is terminated | After re-listen, every admin and public subscriber receives `{ kind: 'resync' }` once |
| Own event | `POST /api/v1/incidents` on a listening app | The admin subscriber receives `incident.created` exactly once |
| Worker | A scoped worker child process has logged "Worker is ready" | No `watchdog-listener:<child pid>` backend exists, while this file's own listening app has exactly one under its pid |
| Start fails | The first `listen` rejects | The dedicated client is ended and `buildApp` rejects. No background re-listen keeps the process alive |
| Close | `app.close()` | Each subscriber receives `{ kind: 'closed' }` once. The listener backend is gone from `pg_stat_activity` |

</frozen-after-approval>

## Code Map

- `src/shared/realtime/realtime-event.ts`: reuse `NOTIFY_CHANNEL`, `RealtimeEvent` and `BRIDGED_EVENT_NAMES`. It is pure.
- `src/shared/db/tenant-transaction.ts:43` `assertValidBetterAuthOrgId` throws `InvalidOrganizationIdError`. The file imports the global `postgres.ts` (env), so only the listener may import it, never a unit-tested pure file.
- `node_modules/postgres/src/index.js:147-182` `listen`:
  - It creates an inner `max: 1` client.
  - On close it re-listens and calls `onlisten` again. The first `onlisten` is the initial listen, and every later call is a re-listen.
  - It returns `{ state: { pid }, unlisten }`.
  - `end()` on the owning instance also ends the inner client.
  - `unlisten` alone keeps the connection open.
- `src/shared/db/postgres.ts`: pattern for creating a client. It goes through `sqlDebugOption(env.log.level, …)` (AGENTS rule) and reads `env.db.url` from `@/config`.
- `src/server/build-app.ts:19` `buildApp(overrides)` takes Fastify options only. Its callers:
  - `src/api.ts:8`
  - `src/worker.ts:461`
  - `tests/support/server.ts`, which needs no listening yet and stays unchanged
  - about 50 integration files
- `src/api.ts:18-36`: `fastify.close()` runs before `closeDbConnection`.
- `src/shared/cqrs/index.ts`: `onClose` hook pattern, and `fastify.decorate` for the buses with their type augmentation.
- `src/shared/testing/notifications.ts`:
  - `listenForOrg`, `settle` and the sentinel `{ eventName: 'test.sentinel' }`.
  - The api listener would drop that sentinel with a `warn` in every listening test app.
- `src/shared/testing/worker-process.ts` `spawnScopedWorker(orgIds, env)`: the child's `pid` is the worker itself. Copy the env setup from `src/worker-lifecycle.integration.test.ts:126`.
- `src/shared/realtime/realtime-event.spec.ts`: pattern for restating DOMAIN's catalog in a spec.
- dependency-cruiser: keep new paths free of `domain`, `infra`, `database`, `repository`, `dtos`, `.handler.ts` and `.route.ts`. Non-test code must not import `src/shared/testing/`.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/ARCHITECTURE.md`: make the edits the decisions name, first and nothing else. 5.2's mermaid is at :205-215, 5.4's prose at :377-383, then :199 and :795.
- [x] `src/shared/realtime/event-visibility.ts`: `PUBLIC_EVENT_NAMES` (a `ReadonlySet`) and `isPublicEvent(name)`.
- [x] `src/shared/realtime/realtime-hub.ts`: `createRealtimeHub(log)` returns:
  - `subscribePublic(orgId, fn)` and `subscribeAdmin(orgId, fn)`, each returning an unsubscribe function.
  - `publish(event)` and `resync()`.
  - The exported signal type is `{ kind: 'event'; event } | { kind: 'resync' } | { kind: 'closed' }`.
  - `close()` sends `closed` to every subscriber and clears them. After it, `publish` and `resync` do nothing, and `subscribe*` delivers `closed` at once and registers nothing.
  - Unsubscribe is idempotent.
  - Each delivery is isolated with try/catch, plus `.catch` on a returned promise.
  - When an org has no subscribers left, delete its entry.
- [x] `src/shared/realtime/notify-listener.ts`:
  - `parseNotification(raw)` returns a `RealtimeEvent` or a drop reason.
  - `startNotifyListener({ sql, hub, log })` returns `{ pid, close }`. It calls `hub.resync()` on every `onlisten` after the first.
  - `close` unlistens, then ends `sql`.
  - If the first `listen` rejects, end `sql` and rethrow.
  - Log a re-listen at `warn` before the `resync`.
- [x] `src/server/realtime/listener.ts`:
  - Creates the dedicated client with `connection.application_name = \`watchdog-listener:${process.pid}\``.
  - Starts the listener and registers an `onClose` that calls `close`.
- [x] `src/server/plugins/realtime.ts`: decorate `realtimeHub` on every app, with the type augmentation. Wrap it in `fastify-plugin`, as `cqrs.ts` does, so the decoration is visible outside the plugin. Add an `onClose` that calls `hub.close()`. The hub is cheap and holds no connection.
- [x] `src/server/build-app.ts`:
  - Add a second parameter, `{ listen = false }`.
  - After `server(app)`, start the listener when `listen` is true.
- [x] `src/api.ts`: call `buildApp({}, { listen: true })`.
- [x] `src/shared/testing/notifications.ts`:
  - The sentinel becomes a bridged, admin-only name (`uptime.rollup_refreshed`) marked by `aggregateType: 'test.sentinel'`. A listening app accepts it, and the public path never sees it, so 4.6 never recomposes for one.
  - `listenForOrg` filters on that `aggregateType`, not on `eventName`.
  - Add `notifyRaw(text)`.
  - Add `subscribeForOrg(hub, orgId)` returning `{ admin, public, settle(app?), close }`.
    - `settle` waits for the sentinel on the admin channel. The hub delivers each notification synchronously and in order, so every earlier public delivery has already happened by then.
    - Sentinels are filtered out of the lists.
- [x] `src/shared/realtime/event-visibility.spec.ts`:
  - Restate DOMAIN's Visibility column for all 27 bridged events.
  - Assert the whitelist is exactly "Public" plus "Public, draft-gated".
  - Name the absent ones: `service.manual_override_*`, `incident.draft_created`, `incident.state_changed`, `incident.dismissed`, every monitor event and every uptime event.
- [x] `src/shared/realtime/realtime-hub.spec.ts`: two orgs, the whitelist gate, a throwing or rejecting subscriber, idempotent unsubscribe, resync to both channels, and `close`.
- [x] `src/shared/realtime/notify-listener.integration.test.ts`: every row of the matrix. Malformed rows use a stub logger, with a unique marker in each payload because other files share the channel. Close comes last.

**Acceptance Criteria:**
- Given the whitelist, when the unit spec compares it with the restated catalog, then it matches exactly, and adding an admin-only name fails the spec.

## Implementation Notes

- **Re-listen and `unlisten`.** After a re-listen, postgres.js registers a new listener object, so the original handle's `unlisten` matches nothing. `close` still ends the client, and that drops the session's LISTEN. This is commented in `notify-listener.ts`.
- **Failed start.** When the first listen fails, `buildApp` also calls `app.close()` before it rethrows, so the plugins release what they hold.
- **Tests that run a child process.** The start-fails row runs `buildApp` in a child against a database that does not exist. Mutation check: with the listener's `sql.end` removed, the child never exits.
- **Real-api case (review patch).** `src/index.ts api` is spawned with `PORT=0`. The test asserts one `watchdog-listener:<child pid>` backend, and that it is gone after SIGTERM.
  - A clean SIGTERM exits 15, not 0. graceful-server calls `process.exit` with the signal's number. That was already the api's behaviour and is unchanged here.
  - Mutation check: with `src/api.ts` reverted to `buildApp()`, the case fails.
- **Malformed rows (review patch).** The test also sends a payload with `missing a field`, a JSON array (`not a JSON object`), and a valid payload with an extra `title`. The extra field is delivered as the six-field event. Mutation check: passing the parsed object through unchanged fails the test.
- **Orchestrator verification (after the patches):**
  - `pnpm run check`: clean.
  - Unit: 293 of 293, both with `.env` and without it.
  - Integration: 670 of 670, twice, with only postgres and mailpit up. No failures to rerun.
  - e2e: 4 of 4.
  - Auth schema: in sync.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-20). Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Nothing proves the real api entrypoint listens (V) | medium | Reverting `src/api.ts:8` to `buildApp()` keeps every test green. The only real-api spawn (`runtime-role.integration.test.ts:113-120`) exits at the role guard | patch (spawned-api case) |
| 2 | `parseNotification`'s six-field rebuild, `missing a field` and `not a JSON object` are untested (V, B) | low | The malformed case covers four reasons. Every valid send already has exactly six fields. The fix adds rows to an existing test | patch |
| 3 | `api.ts` "Before listening" comment is ambiguous now that LISTEN opens in `buildApp` (B) | low | Comment at `src/api.ts:10`. Fixed by direct rewording | patch |
| 4 | `aggregateType`, `aggregateId` and `occurredAt` are only type-checked (E, B) | low | Only roles that can connect can `pg_notify`. Signals are re-read by id. A prefix check would also refuse the uptime aggregate (`organization`) and the sentinel. The fix adds guards | reject |
| 5 | A subscriber that unsubscribes a *different* subscription mid-loop still delivers to it (E) | low | No planned subscriber unsubscribes another one. Self-unsubscribe is handled and tested. The fix guards an undemonstrated state | reject |
| 6 | Resubscribing from a `closed` callback recurses (E) | low | `closed` means the app is closing. No subscriber would resubscribe. The fix adds deferral machinery | reject |
| 7 | A flood of malformed notifications floods `warn` (E) | low | Only connected roles can send. Rate-limiting the log is new machinery | reject |
| 8 | Subscribers are not told while the listener is down (E, B) | false | By design: ARCHITECTURE 5.4 says a lost NOTIFY leaves a stream on its last page, and resync follows re-listen. postgres.js overrides `onclose` on its listen client, so no hook exists | reject |
| 9 | The worker check is name-based only (E, B) | low | It proves the worker opens no listener through `buildApp`, the only listener path. No static rule can separate them: the worker imports `buildApp`, which imports the listener | reject |
| 10 | `close` unlistens nothing after a re-listen (E) | low | Documented at the call site. `sql.end` drops the session's LISTEN, so the outcome holds | reject |
| 11 | The failed-listen test does not prove `buildApp` closes the app (V) | low | Production exits on rejection. Only a same-process caller would keep an auth-pool hold. Proving it needs extra child-process probes | reject |
| 12 | AGENTS.md lacks 4.4's conventions (B) | low | The fix edits an agent-context file | defer |
| 13 | The diff omits the spec and `sprint-status.yaml` (B) | false | Left out on purpose: the spec is the claims file, given only to the edge-case layer, and the status file is tracking | reject |
| 14 | The public channel carries the whole event, including draft-gated ids (B) | low | Epics 4.4 says public subscribers "receive it". Public subscribers are in-process recomposers (4.6), never forwarders | reject |
| 15 | `close` awaits `unlisten` with no timeout (B) | low | Only a half-open connection at shutdown could block it. The spec requires the unlisten | reject |
| 16 | `NotifyListener.pid` has no reader and goes stale after a re-listen (B) | low | The spec's task names `{ pid, close }`, so removing it means editing the spec | reject |
| 17 | The DOMAIN visibility table is restated in a second spec (B) | low | The repo's pattern (`incident.state-machine.spec.ts`, 4.3 row #10) | reject |
| 18 | The sentinel is a real event name that admin subscribers see (B) | low | Recorded in the `notifications.ts` header. 4.7's tests filter as `subscribeForOrg` does. AGENTS note deferred in #12 | reject |
| 19 | ARCHITECTURE 5.4's sketch still shows `isPubliclyVisibleEvent` (B) | false | The sketch is labelled "Unimplemented design sketch", and the 2026-10-18 paragraph already makes the page the gate | reject |

## Design Notes

- **Why a dedicated connection.** The criterion "connection released before the pool closes" cannot hold on the shared client. Its inner listen client ends only with `sql.end()`. A per-app client also gives the test a `pid` to terminate and a name to look up. It adds one Postgres connection per listening app.
- **Reconnect.** postgres.js's inner client re-listens on every close and keeps retrying until it succeeds (`index.js:156-161`, `connection.js:436-457`). `onlisten` fires after each success, so the api needs no reconnect loop of its own. While it is down, signals are lost (ARCHITECTURE 5.1), and the next `resync` covers the gap.
- **Order.** The listener starts inside `buildApp`, before `src/api.ts`'s role check. A superuser api would open its LISTEN and then exit. That is harmless, since the connection reads no tenant data.
- **Why `buildApp` opts in.** Test apps are built through `buildApp`, not `startApi`. A default of off keeps the roughly 50 integration files from each opening a listen connection. The worker gets the safe answer without passing anything.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice, with only postgres, mailpit and migrate up -- expected: all pass. Rerun any failure two or three times and report it.
- `pnpm run test:e2e` -- expected: all pass.
- `pnpm run auth:schema:check` -- expected: in sync.
