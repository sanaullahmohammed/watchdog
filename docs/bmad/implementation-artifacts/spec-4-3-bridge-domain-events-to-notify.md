---
title: 'Story 4.3 — Bridge domain events to NOTIFY'
type: 'feature'
created: '2026-10-18'
status: 'done'
baseline_commit: '2664ca5a45f806700afa8cb492192a30e1d4564b'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Domain events reach only handlers in the emitting process. A change the worker makes cannot reach a client connected to the api, so Epic 4's stream and subscriptions have nothing to listen to.

**Approach:** Every app instance (api, worker, tests) registers one bus handler per bridged event. It sends `pg_notify('watchdog_events', …)` with a small, fixed payload, after the command commits. The bridged set is keyed by the event creators in `src/shared/events/`, so names come from code, not strings.

**Decisions (owner, 2026-10-18):**
- `uptime.rollup_refreshed` carries `aggregateType: 'organization'` and `aggregateId: orgId`, because the refresh covers the whole organization.
- `docs/genesis/DOMAIN.md`: edit the LISTEN/NOTIFY channel sketch only. Record the `aggregateType`/`aggregateId` rule, the uptime case, and `occurredAt` as the emit time (`meta.timestamp`), matching ARCHITECTURE 5.3, instead of `now()`.

## Boundaries & Constraints

**Always:**
- Payload is exactly `{ eventName, orgId, aggregateType, aggregateId, occurredAt, version: 1 }`. `eventName` is the dotted form (`incident/created` → `incident.created`).
- The bridged set is ARCHITECTURE 5.3's: every event DOMAIN marks "Yes", plus `uptime.rollup_refreshed`. Nothing marked "No". Of the "Optional" events, only `uptime.rollup_refreshed`.
- `aggregateType` is the event's prefix (`service`, `service_group`, `incident`, `maintenance`, `monitor`). `aggregateId` is `payload.id`, or `payload.monitorId` for `monitor.*`. The exception is `uptime.rollup_refreshed`, which carries `'organization'` / `orgId`.
- `occurredAt` is the ISO form of the bus's `meta.timestamp`, which `decorateWithMetadata` stamps at emit. It is not `now()` in SQL. `toRealtimeEvent` throws when `meta.timestamp` is missing rather than inventing a time.
- The handler returns its promise. A failure then reaches `onHandlerError`, and `app.close()` drains it.
- An integration test filters notifications by its own `orgId`.

**Never:**
- No title, message, name, slug, address, `from`/`to`, `updateId` or other payload field on the wire.
- No `LISTEN` in app code (that is story 4.4). No migration. No new config.
- No `setNotFoundHandler`. No edit to `AGENTS.md`. In `docs/genesis`, only DOMAIN's channel sketch changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Bridged event | `POST /api/v1/incidents` commits | One notification for that org: `incident.created`, `aggregateType: 'incident'`, `aggregateId` = the incident id, and the exact key set |
| Monitor event | `monitor/threshold_breached` emitted | `aggregateType: 'monitor'`, `aggregateId` = `monitorId` |
| Not bridged | `monitor/created`, `monitor/check_failed` | No notification |
| Rolled back | Incident naming another org's service (composite FK refuses, 400) | No notification for that org |
| pg_notify refused | The bridge's `sql` rejects | `onHandlerError(error, event)` called. `emit` does not throw. A handler registered after it still runs. Over HTTP, the command still answers 201 |
| Two orgs | Org A and org B each emit on one app | Each org's listener sees only its own notifications |
| Closing | Emit, then `app.close()` without `drain()` | The notification still arrives |

</frozen-after-approval>

## Code Map

- `src/shared/cqrs/event-bus.ts`
  - `on(type, handler)` takes one type per call. There is no wildcard.
  - `emit` is synchronous. A returned promise is tracked, and its rejection goes to `onHandlerError`.
  - `drain()` waits for every tracked promise.
- `src/shared/cqrs/middlewares.ts:9` `decorateWithMetadata` sets `meta.timestamp = meta.timestamp ?? Date.now()` on the shared action, synchronously inside `emit`, before each handler. The first handler to run stamps it, and it returns the handler's promise, so tracking still works. `src/shared/cqrs/index.ts` adds it to the event bus and logs `onHandlerError` as `{ err, eventType }`, which the redaction covers.
- `src/server/plugins/cqrs.ts`
  - This is the wiring site: after `register(fastifyCqrs)`, call `registerNotifyBridge(fastify.eventBus, sql)` with `sql` from `@/shared/db/postgres`.
  - It is a server-layer plugin that the api, the worker (`src/worker.ts:461` uses `buildApp`) and every test app load.
  - It keeps `src/shared/cqrs` and the unit specs free of the global connection.
- `src/shared/events/{service,incident,maintenance,monitor}.events.ts` export the creators, each with a `.type`.
  - Payloads: `{id, orgId, …}` for service, service_group, incident and maintenance. `MonitorEventPayload` is `{orgId, monitorId, serviceId, monitorName}`. `uptimeRollupRefreshedEvent` is `{orgId, from, through, written, pruned}`.
  - Every bridged creator has a non-test emit site in `src/modules` (`incidentResolvedEvent` and `incidentDismissedEvent` are picked by a ternary at `transition-incident.handler.ts:129`).
- `docs/genesis/DOMAIN.md`: the catalog is at :1359-1444 and the channel sketch at :1446-1491. `ARCHITECTURE.md` 5.3 is at :220-316, with `EVENTS_TO_BRIDGE` at :262.
- `src/modules/incident/domain/incident.state-machine.spec.ts` is the pattern for "restate DOMAIN's table in the spec so drift fails".
- `src/modules/incident/declare-incident.integration.test.ts`
  - It shows the app, org and incident setup: `buildApp`, `signUpWithOrg`, `createService` and `postIncident`.
  - :179 is the cross-org rollback case.
- `postgres` `sql.listen(channel, cb)` (`node_modules/postgres/types/index.d.ts:692`) opens a dedicated connection and returns `{ unlisten }`. Nothing in `src` uses `pg_notify` or `listen` yet. `watchdog_app` keeps the default `pg_notify` grant.
- `src/shared/cqrs/event-bus.integration.test.ts:96-109` is the pattern for "close drains handler work".
- `src/shared/api/contract/authenticated-surface.spec.ts` is the pattern for a spec that reads source files with `readdirSync`/`readFileSync` from `import.meta.dirname`.
- `postgres.ts` reads `env`, which fails without `DATABASE_URL`, so unit specs must not import it. `notify-bridge.ts` uses `import type { Sql } from 'postgres'`.
- `worker-health.integration.test.ts:317,341` and `worker-lifecycle.integration.test.ts:184,645` end the global `sql` deliberately. A bridged emit after that would only log an `onHandlerError`.
- ARCHITECTURE 5.2 draws a worker LISTEN subscriber, while the epic context says only the api listens. That is a known divergence for 4.4 and is not changed here.
- dependency-cruiser
  - Avoid `domain`, `infra`, `database`, `repository` and `dtos` in the new paths, because the layer regexes are unanchored.
  - Non-test code must not import `src/shared/testing/`.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/realtime/realtime-event.ts`
  - `NOTIFY_CHANNEL`, the `RealtimeEvent` payload type and `toWireName`.
  - `BRIDGED_EVENTS`: a list of `{ creator, aggregate(payload) → { aggregateType, aggregateId } }`.
  - `BRIDGED_EVENT_NAMES`, and `toRealtimeEvent(action)` that builds the payload.
  - It is pure, with no import of `postgres.ts`.
- [x] `src/shared/realtime/notify-bridge.ts`
  - `registerNotifyBridge(eventBus, sql)` registers one handler per bridged creator.
  - Each handler returns `` sql`select pg_notify(${NOTIFY_CHANNEL}, ${JSON.stringify(payload)})` ``.
- [x] `src/server/plugins/cqrs.ts`: wire the bridge as described in the Code Map.
- [x] `src/shared/realtime/realtime-event.spec.ts`
  - Restate DOMAIN's catalog (name to Yes, No or Optional) and assert the bridged set is exactly Yes plus `uptime.rollup_refreshed`.
  - Assert every bridged name is a `.type` exported from `src/shared/events/`.
  - Assert each bridged creator is emitted. Read `src/modules` recursively. Skip `*.test.ts`, `*.spec.ts` and `*.event-handler.ts` (subscribers). Strip import statements. Then require the creator's export name to remain. That covers the ternary at `transition-incident.handler.ts:129-130`, while an import or subscription alone does not count.
  - Assert `toRealtimeEvent` gives the exact key set for an incident, a monitor and the uptime event, and drops extra payload fields.
  - Assert it throws without `meta.timestamp`.
- [x] `src/shared/realtime/notify-bridge.spec.ts`: the refused row of the matrix. Use a real `eventBus({ onHandlerError })`. The `sql` stub is a tagged-template function that returns a rejected promise.
- [x] `src/shared/testing/notifications.ts`
  - `listenForOrg(orgId)` returns `{ received, settle(), close() }`.
  - It uses `sql.listen` on the global connection, and `close()` calls `unlisten`.
  - `settle(app)` sends a sentinel `pg_notify` for that org after `app.eventBus.drain()`. The sentinel has `eventName: 'test.sentinel'` and a unique id per call. `settle` resolves when that sentinel arrives and rejects on a timeout. A negative assertion therefore never sleeps.
  - `received` excludes sentinels.
- [x] `src/shared/realtime/notify-bridge.integration.test.ts`: the bridged, monitor (emit the creator directly on `app.eventBus`), not-bridged, rolled-back, two-org and closing rows of the matrix, each filtered by its own org.
  - Refused over HTTP: on a dedicated app, register a second bridge with a rejecting `sql`. `POST` an incident, expect 201, and expect the real bridge's notification to still arrive.
  - Closing comes last on its own app, as in `event-bus.integration.test.ts`.
- [x] `docs/genesis/DOMAIN.md` :1446-1491, channel sketch: state the aggregate rule, the uptime case and `occurredAt` as emit time. Change nothing else in DOMAIN.

**Acceptance Criteria:**
- Given the bridged set, when the unit test compares it with the restated catalog, then it matches exactly, and a renamed creator or a removed emit site fails the test.

## Implementation Notes

- Emit-site check: skipping every `*.event-handler.ts` would fail `service.status_changed`, whose only emit site is `recompute-service-status.event-handler.ts:127`. A subscriber file therefore counts only where it calls `emit(<creator>(`. Its trigger lists and `.type` references still do not count. The spec asserts that a subscriber's mention of `monitorThresholdBreachedEvent` is not counted as an emit. Mutation-checked: removing the recompute emit, or the dismissed branch of the ternary, fails the test.
- The spec reads files from `__dirname`, not `import.meta.dirname`, because the project compiles to CommonJS. `authenticated-surface.spec.ts` does the same.
- The `app` argument to `settle` is optional. The closing case omits it, because draining there would hide a close that skipped its drain. Mutation check: with the `onClose` drain removed, the closing case still passes in 3 of 3 runs. The bridge's query is issued at emit, and `app.close()` does not end the global pool, so this row does not tell a drained close from an undrained one. The drain is proven in `event-bus.integration.test.ts`.

**After the review patches (rows #1-#7):**
- The emit-site reader now parses each file with the TypeScript compiler, drops every import (side-effect imports included) and prints it without comments. Mutation-checked: with `incidentDismissedEvent` left only in a comment, the test fails.
- The orchestrator verified:
  - `pnpm run check`: clean. Biome's 11 warnings are in files this change does not touch.
  - Unit: 281 of 281, with `.env` and without it.
  - Integration: 661 of 661, twice, with only postgres and mailpit up (migrate had run). No failures to rerun.
  - `notify-bridge`, `worker-health` and `worker-lifecycle` run alone, before the patches: 35 of 35.
  - e2e: 4 of 4 scenarios.
  - The auth schema is in sync.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-18): blind hunter (B), edge-case hunter (E), verification gap (V, no gaps found).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | `occurredAt` window uses wall-clock `Date.now()` and will flake on the WSL2 clock (B, E, V) | medium | Integration test :180-181; AGENTS.md records steps back of up to 1.4 s | patch (2 s slack) |
| 2 | The "names no orgId" guard has no test (B) | low | `realtime-event.spec.ts` covers timestamp and unbridged throws only. The guard keeps an unscoped signal off the channel | patch |
| 3 | The closing case's comments say it guards the drain, which it cannot show (B) | low | Implementation Notes: passes with the drain removed. The drain is proven in `event-bus.integration.test.ts` | patch (comments in test and `settle` doc) |
| 4 | DOMAIN says an unstamped event "is not bridged"; really the handler throws and the bus logs a failure (B) | low | `toRealtimeEvent` throws; `cqrs/index.ts` logs at error | patch (wording) |
| 5 | Emit-site reader counts a creator named in a comment; import regex mis-strips a side-effect `import 'x';` (B, E) | low | `emitSitesOf` matches any `\bname\b`; `withoutImports` lazy `[\s\S]*?from` | patch (strip comments, anchor import regex) |
| 6 | `settle` timeout can reject `arrived` before it has a handler (E) | low | `arrived` is awaited only after the sentinel query resolves | patch |
| 7 | A new `*.events.ts` file escapes the catalog checks (E) | low | `EXPORTED_CREATORS` imports four files by name; Epic 6 will add notification events | patch (assert the directory lists exactly these four) |
| 8 | ARCHITECTURE 5.3's sketch still builds the payload with `json_build_object` (B) | low | Semantics match (six keys, emit-time `occurredAt`); only the SQL shape differs. The frozen intent limits genesis edits to DOMAIN's sketch | defer |
| 9 | Missing `aggregateId` gives a five-key payload (B, E) | low | Creators type `id`/`monitorId` as `string`, and every emit site passes one (V checked each). The fix adds a guard for an undemonstrated state | reject |
| 10 | Restated catalog does not detect a DOMAIN edit (B) | low | The repo's pattern (`incident.state-machine.spec.ts`); parsing markdown is more than a direct correction | reject |
| 11 | DOMAIN omits at-most-once delivery (B) | false | ARCHITECTURE 5.1 records no retry and post-commit emit; the epic context records "No durability" | reject |
| 12 | The channel is shared by all tenants (B) | low | The listener's filter is story 4.4; this story sends org-scoped payloads | reject |
| 13 | One `pg_notify` per event contends for the pool (B, E) | maybe-false | Would need a burst measurement; a `select pg_notify` holds a connection for one round trip. If true, it would only be low | reject |
| 14 | A second registration doubles notifications silently (B) | false | The first integration case asserts exactly one `incident.created` from a `buildApp` app (V) | reject |
| 15 | The HTTP refusal test does not prove later handlers run (B) | false | Its name claims 201 and announcement only; the unit spec covers later handlers | reject |
| 16 | `RealtimeEvent` types `eventName`/`aggregateType` as `string` (B) | low | A 4.4 convenience; no defect here | reject |
| 17 | `listenForOrg` does not guard `JSON.parse` (B, E) | low | Only this codebase sends on `watchdog_events`, always JSON; the fix is a guard | reject |
| 18 | `settle()` without `app` can settle early (B) | low | Documented; only the closing case omits it | reject |
| 19 | Listeners can receive notifications out of emit order (E) | low | Payloads are signals and listeners re-read; serializing adds machinery | reject |
| 20 | The spec says skip `*.event-handler.ts`; the code counts their `emit(` calls (E) | low | Recorded in Implementation Notes; the fix edits this spec | reject |
| 21 | Removing one of two emit sites still passes (E) | false | The story's requirement is that each bridged event has an emitter; it still does | reject |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice, with only postgres, mailpit and migrate up -- expected: all pass. Rerun any failure two or three times and report it.
- `pnpm run test:e2e` -- expected: all pass.
- `worker-health` and `worker-lifecycle` integration suites run once alone -- expected: pass, with no new failure from the bridge.
- `pnpm run auth:schema:check` -- expected: in sync.
