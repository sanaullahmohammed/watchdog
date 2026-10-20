---
title: 'Story 4.5 — Open a public status stream'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: '827d7bf26f2087efee81920301636a2b56085437'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** An integrator can poll `/status/:orgSlug`, but cannot hold a connection that live pages will arrive on. Story 4.6 pushes pages through such a connection, so the stream must first exist, with the anonymous surface's bounds.

**Approach:** Add `GET /status/:orgSlug/events`, a public SSE route in a new `status-page` slice:
- It answers a miss exactly as the page does.
- It sends the current page once as its first event, with the page's `ETag` as the SSE `id`.
- It holds a public hub subscription and writes heartbeats.
- It is bounded by the rate limit, a per-IP cap, a per-process cap and a lifetime, and ends cleanly on disconnect and on `app.close()`.

**Decisions (owner, 2026-10-20):**
- ARCHITECTURE 7.1 gains one paragraph naming this slice as REST-only by design (SSE has no SDL form, and GraphQL subscriptions are admin-only). It lands before the code. No other genesis edit.
- Only the stream's own preflight is added. Deferral 4.1 #21 (preflights to misses under `/status`) is retargeted to Epic 8.
- Each event is unnamed (no `event:` line), so `EventSource.onmessage` receives it.
- The spec stays whole (about 2,300 tokens).

## Boundaries & Constraints

**Always:**
- The first event's `data` is the same document `GET /status/:orgSlug` returns, built by the same query, presenter and `publicPageETag`.
- Stream headers:
  - `content-type: text/event-stream; charset=utf-8`
  - `cache-control: no-store`
  - `x-accel-buffering: no`
  - `publicHeaders`, and no `etag`
- Every refusal (404, 429, 500) goes through the error handler as an `ExceptionBase` and carries the public headers.
- Cap refusals are `TooManyRequestsException`. A refused or failed opening holds no cap place and no hub subscription.
- `Last-Event-ID` is ignored.
- One cleanup path, idempotent, runs on client close, lifetime end, write error and the hub's `closed`. It releases the cap places, unsubscribes, clears both timers and ends the response.
- New config goes only through `src/config/env.ts` and `.env.example`.

**Never:**
- No `setNotFoundHandler`. No migration. No `AGENTS.md` edit.
- No push on hub events, no coalescing, no recomposition on `resync`. Those are 4.6.
- In `docs/genesis`, nothing beyond what the decisions name.
- Integration tests run with only postgres, mailpit and migrate up.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Open | Valid slug | 200 with the stream headers. First event `id: <ETag>`, `data: <page JSON>`, equal to a `GET` made just after (ignoring `generatedAt`) and to its `etag` |
| Heartbeat | Open stream, nothing written for one interval | A `: heartbeat` comment |
| Miss | Unknown slug, invalid slug, slug over `maxParamLength` | The page's 404 body and public headers. Nothing opened |
| Preflight | `OPTIONS /status/x/events` | 204, public headers, `access-control-allow-methods: GET, OPTIONS`, `access-control-allow-headers: last-event-id`, `max-age` 86400. No database read, not rationed |
| Reconnect | `Last-Event-ID: "stale"` | First event is the current page |
| Per-IP cap | `PUBLIC_STREAM_MAX_PER_IP` open from one IP | Next opening 429 with public headers. Closing one lets the next open at once |
| Total cap | `PUBLIC_STREAM_MAX_TOTAL` open across IPs | Next opening, from any IP, 429 |
| Rate limit | Openings beyond `PUBLIC_RATE_LIMIT_MAX` per window | 429, the route's own bucket of the page's size |
| Lifetime | Open for `PUBLIC_STREAM_MAX_LIFETIME_SECONDS` | Server ends the response and frees its places |
| Gone early | Client disconnects while the page is being composed | Nothing is admitted or subscribed |
| Close | `app.close()` with streams open | Each response ends, places and subscriptions are released, and `close()` resolves without waiting on the client |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts`: the pattern for the new route.
  - `config.rateLimit` from `env.publicSurface.rateLimit`.
  - `onSend` with `publicHeaders`: refusals thrown before the hijack get the headers this way.
  - The `OPTIONS` route at :106-117.
  - The catch-alls `/status` and `/status/*` at :125-157. The new, more specific route wins over `/status/*`.
  - Reuse `getPublicStatusPageRequestParamsSchema`, which is a plain string, so a bad slug still reaches `resolveOrganizationBySlug`.
- `get-public-status-page.handler.ts`: `getPublicStatusPageQuery({ slug })` resolves the slug (uniform `NotFoundException`) and composes under `withTenantTransaction(..., { isolation: 'repeatable read', readOnly: true })`. `view.organization.id` is the hub key.
- `src/modules/status-page/dtos/public-status-page.{present,etag}.ts`: `toPublicStatusPage` and `publicPageETag`. These are the api layer, so only a `.route.ts` may import them. dependency-cruiser's `no-command-query-to-api-deps` forbids `.handler.ts` importing them.
- `src/server/di/index.ts:36-50`: every `*.handler.ts` is loaded as a query or command handler (default-export factory plus `init`).
- `src/shared/api/public-surface.ts` `publicHeaders`. `src/shared/exceptions` `TooManyRequestsException` (message only; sets no `Retry-After`).
- `src/server/plugins/realtime.ts`: `app.realtimeHub` exists on every app. Today its `onClose` calls `hub.close()`, which sends `{ kind: 'closed' }`. That is too late for a stream (see Design Notes). `src/shared/realtime/realtime-hub.ts`: `subscribePublic(orgId, fn) => unsubscribe`.
- `src/config/env.ts:46-48,112-116`: `PUBLIC_*` declarations and the `env.publicSurface` mapping. `.env.example` has no `PUBLIC_*` lines yet.
- `src/shared/api/contract/authenticated-surface.spec.ts:38-67`: `PUBLIC_BY_DESIGN`. It reads only `.route({ method, url })` with literal strings, and fails on a stale key.
- `src/shared/api/contract/api-surface-parity.spec.ts:171-186`: the coverage test. Slice labels are `<module>/<kind>/<dir>`.
- `docs/genesis/ARCHITECTURE.md:804-817`: 7.1.
- `src/shared/testing/`:
  - `tenant.ts` `signUpWithOrg(app, label)`: the slug is the label.
  - `fixtures.ts` `createService`.
  - `notifications.ts` `subscribeForOrg` and `notifyRaw`: use these if a test needs a real NOTIFY, rather than new helpers.
- `src/shared/realtime/notify-listener.integration.test.ts`: the pattern for spawning `src/index.ts api` with `PORT=0` and reading its port.
- No integration test under `src` uses `app.listen` yet. Use `app.listen({ port: 0, host: '127.0.0.1' })` and `node:http`. `node:http` can set `localAddress` (`127.0.0.2`) for a second client IP; `fetch` cannot.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/ARCHITECTURE.md`: the 7.1 exemption paragraph. Do this first, and nothing else there.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md`: retarget the 4.1 #21 preflight entry to Epic 8, saying 4.5 added only its own preflight.
- [x] `src/config/env.ts` and `.env.example`, under `env.publicSurface.stream`:
  - `PUBLIC_STREAM_MAX_PER_IP` (10), `PUBLIC_STREAM_MAX_TOTAL` (1000), `PUBLIC_STREAM_MAX_LIFETIME_SECONDS` (3600) and `PUBLIC_STREAM_HEARTBEAT_SECONDS` (30).
  - Each is `Type.Number` with minimum 1, like the other `PUBLIC_*` entries. The two time settings have a maximum of 2,147,483 (setTimeout's limit in seconds).
  - `.env.example` lists them commented, with their defaults.
- [x] `src/server/plugins/realtime.ts`: call `hub.close()` from a `preClose` hook instead of `onClose`, and update its comment. The 4.4 listener's `onClose` then still runs after it, so `closed` still precedes the unlisten.
- [x] `queries/open-public-status-stream/public-stream-admission.ts` and `.spec.ts`:
  - `createStreamAdmission({ maxPerIp, maxTotal })` returns `admit(ip)`, which gives `release` or `undefined`.
  - `release` is idempotent, and an IP's entry is deleted at zero.
  - Unit spec: both caps, release, double release.
- [x] `open-public-status-stream.handler.ts`: query `stream.open`, `{ slug }` in, `PublicStatusPageView` out, by executing `getPublicStatusPageQuery`. It is the seam 4.6 recomposes through.
- [x] `open-public-status-stream.public.route.ts`:
  - `GET /status/:orgSlug/events` with `exposeHeadRoute: false`, the page's `config.rateLimit`, and an `onSend` with `publicHeaders`.
  - One admission per app, made in the plugin closure.
  - The handler, in order:
    1. Execute the query and present the page.
    2. If `reply.raw.destroyed`, return without sending.
    3. `admit(req.ip)`, or throw `TooManyRequestsException`.
    4. Set the stream headers, then `publicHeaders(reply)` last, so its `cross-origin-resource-policy` overrides helmet's (`reply.getHeaders()` merges helmet's raw headers). Then `reply.hijack()` and `reply.raw.writeHead(200, reply.getHeaders())`. The route's `onSend` covers only answers before the hijack.
    5. Write the first event: `id: <ETag>` and `data: <page JSON>`, with no `event:` line.
    6. `fastify.realtimeHub.subscribePublic`, read at request time. `closed` runs the cleanup. On a closed hub this calls back before it returns, so cleanup sets a `done` flag and tolerates an unassigned unsubscribe.
    7. Unless `done`, start the heartbeat (reset on every write) and the lifetime timer, and attach cleanup to `reply.raw` `close` and `error`.
  - Steps 4 to 7 sit in a try/catch that runs cleanup on a throw, since no error handler runs after the hijack. The handler never returns a payload after the hijack.
  - Separately, `OPTIONS /status/:orgSlug/events`.
- [x] `authenticated-surface.spec.ts`: allowlist `GET` and `OPTIONS /status/:orgSlug/events`, each with its reason.
- [x] `api-surface-parity.spec.ts`:
  - `REST_ONLY_BY_DESIGN`, keyed `status-page/queries/open-public-status-stream`, filtered out of the coverage test.
  - A stale-entry test: each key must name a discovered slice that has a route and no resolver.
- [x] `src/modules/status-page/public-status-stream.integration.test.ts`: every matrix row.
  - Lifetime, heartbeat and the total cap run in a spawned api with small env values.
  - The per-IP cap uses the default of 10, in process.
  - The rate limit floods unknown-slug openings on a separate app.
  - Subscription release is checked by wrapping `app.realtimeHub.subscribePublic` in the test.
  - The open row asserts `cross-origin-resource-policy: cross-origin` on the 200.
  - The close row uses a listening socket and asserts `app.close()` resolves within a bound. Mutation check: with the hook back on `onClose`, it hangs.
  - Close comes last.

**Acceptance Criteria:**
- Given the contract specs, when they run, then both pass, and adding any other REST-only slice, or a stale exemption, fails the parity spec.
- Given `HEAD /status/x/events`, when sent, then it opens no stream and answers the catch-all's uniform miss.

## Implementation Notes

- **Review patches (pass 1):**
  - The action creator is renamed `openPublicStatusEventStreamQuery`, to match ARCHITECTURE:51.
  - A failure after the hijack is logged through `logFailure`.
  - Comments are corrected in `env.ts`, `.env.example`, `public-surface.ts` and the allowlist reason.
  - Tests added: the heartbeat repeats; a matching `Last-Event-ID`; a throw after the hijack; SIGTERM with a stream open; `spawnApi`'s signal exit.
- **Mutation checks:**
  - With the hub's hook back on `onClose`, the close test times out.
  - Without the `reply.raw.destroyed` return, the gone-early test fails.
  - Without `release()` in cleanup, the per-IP test fails.
  - With the `REST_ONLY_BY_DESIGN` key renamed, both parity tests fail.
  - Without `armHeartbeat()` in `send`, the heartbeat test fails.
- **A throw after the hijack** destroys the socket in the tick the head is written, so the client usually sees a hang-up rather than a head. The test accepts either.
- **Orchestrator verification:**
  - `pnpm run check`: clean (11 warnings, all pre-existing).
  - Unit: 299 of 299, with `.env` and without it.
  - Integration, first two runs: run 1 had 682 of 683, failing triage row #21. Run 2 had 683 of 683, and the file alone passed 3 of 3. After the clock fix, two more runs: 683 of 683 each.
  - e2e: 4 of 4 scenarios.
  - Auth schema: in sync.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-20). Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The query name differs from ARCHITECTURE's module table (B) | low | ARCHITECTURE:51 names `OpenPublicStatusEventStreamQuery`. The code has `openPublicStatusStreamQuery`. Renaming the action creator aligns them without a genesis edit; the slice path is fixed by the epics file | patch |
| 2 | The heartbeat setting has no genesis record, yet the `env.ts` comment cites 5.4.1 for all four settings (B) | low | 5.4.1:396 lists three stream bounds, and the heartbeat is not one. The comment fix is direct. A genesis record needs the owner | patch (comment) + defer (record) |
| 3 | A cap 429 has no `Retry-After`, and `EventSource` stops for good on any non-200 (B, E, V) | low | No value is meaningful, since a place frees when another client leaves. `EventSource` ignores `Retry-After`, and the rate limiter's 429 has the same effect. The owner decided the caps answer "the same 429" | reject |
| 4 | Every stream expires at the same moment, so they reconnect together (B, E) | low | Real only for streams opened together, such as after a restart. Self-hosted scale, and the rate limit spreads reconnections per IP. Jitter is behaviour the spec does not ask for | reject |
| 5 | Writes ignore backpressure (B, E) | low | In 4.5 the writes are one page plus a 13-byte heartbeat every 30 s. It matters once 4.6 pushes pages, which the intent places in 4.6 | defer (4.6) |
| 6 | A failure after the hijack is logged with `req.log.error`, not `logFailure` (B) | low | AGENTS says both surfaces log failures through `logFailure` with a correlation id. The route's catch does not | patch |
| 7 | The integration test asserts `maxPerIp === 10`, which ties it to the developer's `.env` (B) | low | `public-status-stream.integration.test.ts`, per-IP test. The loop already uses `max`, so the assertion only adds the dependency | patch (delete) |
| 8 | The settings accept fractions although `.env.example` says "whole seconds", and a heartbeat at or above the lifetime is accepted (B, E) | low | `Type.Number`, as the spec chose to match the other `PUBLIC_*` settings. Fractional times work as timer delays. The comment's promise is the defect. The heartbeat and lifetime order adds a cross-field guard for a misconfiguration | patch (comment); reject (cross-field) |
| 9 | The failure path after the hijack is untested (B, V) | low | V filed it as defer. The test already wraps `subscribePublic`, so a wrapper that throws once exercises the catch at no new cost | patch (test) |
| 10 | The "gone early" test can pass vacuously after one `setImmediate` (B) | low | Its admission half proves no place was held: 10 opens and then a 429 from that IP. A positive completion signal for a reply Fastify never sends has no clean hook | reject |
| 11 | Shutdown through the real entrypoint is untested with a stream open (B) | medium | `src/api.ts:18-36`: graceful-server runs `fastify.close()` in `closePromises`. The spawned api already exists, so SIGTERM with a stream open is cheap to test | patch (test) |
| 12 | One actor, or an IPv6 /64, can fill the total cap and lock out every organization (B, E) | low | Keying on the full address is the owner's 5.4.1 decision, shared with the rate limit (F-18). Prefix grouping or per-org shares are a new policy | defer (Epic 8) |
| 13 | The `publicHeaders` doc comment omits the stream's hijacked head (B) | low | `src/shared/api/public-surface.ts` lists every place the headers are applied | patch |
| 14 | The allowlist reason ("once on open, then heartbeats") goes stale in 4.6 (B) | low | `authenticated-surface.spec.ts`. Rewording is direct | patch |
| 15 | Nothing checks that the heartbeat repeats (V) | medium | Removing `armHeartbeat()` from `send` keeps the test green. The 1 s / 3 s spawned api allows two | patch (test) |
| 16 | Nothing checks a `Last-Event-ID` equal to the current ETag (V) | low | Only `"stale"` is sent. A skip-if-equal shortcut would pass | patch (test) |
| 17 | The preflight admits only `last-event-id`, while polyfills send `cache-control` (E) | low | The owner's decision names `Last-Event-ID`. Native `EventSource` sends no other non-safelisted header | reject |
| 18 | `spawnApi` ignores a signal exit and waits the full deadline (E) | low | `exitCode` stays null when the child is killed by a signal. A one-condition fix | patch |
| 19 | Binding 127.0.0.2-5 fails off Linux (E) | low | CI and the dev machine are Linux. Loopback aliases are standard there | reject |
| 20 | The close test covers only `Connection: close` clients (E) | false | A bare-Fastify repro with a keep-alive agent, a hijacked stream and `preClose` closed in 3 ms | reject |
| 21 | The lifetime test timed itself with `Date.now()` and failed once in the full suite: "not before the lifetime" in a 3,037 ms test (orchestrator verification) | low | The WSL2 wall clock steps back by up to 1.4 s (AGENTS). The test passed 3 of 3 alone and in the next full run. Elapsed checks now use `performance.now()` | patch (orchestrator) |

## Design Notes

- **Compose, then admit, in one tick.** Steps 2 to 6 have no `await`, so a cap count cannot be overtaken between the check and the hijack. A refused opening has already cost one composition. The rate limit bounds that, and a 404 still wins over a 429.
- **Why `exposeHeadRoute: false`.** Fastify's automatic HEAD would run the GET handler, hijack, and hold a bodiless stream open.
- **Close order.** avvio runs `onClose` hooks last-in-first-out, and Fastify registers its own (preClose, `closeIdleConnections`, `server.close`) at `preReady`, after every plugin's (`fastify.js:374-420`, avvio `index.js:311`). So it runs first, and `server.close` waits on the open stream forever: the hub's `onClose` never runs. `preClose` runs before `closeIdleConnections`, and an ended response leaves its connection idle, so it is closed. A bare-Fastify repro hung with `onClose` and closed in 6 ms with `preClose`.
- **Per-IP cap behind a proxy.** `trustProxy` is off, so like the rate limit (ARCHITECTURE 5.4.1, F-18) the cap keys on the socket address, and behind a proxy all callers share 10 streams.
- **The `id` is the ETag verbatim, quotes included**, so a client can compare it with the page's `etag` header unchanged.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice, with only postgres, mailpit and migrate up -- expected: all pass. Rerun any failure two or three times and report it.
- `pnpm run test:e2e` -- expected: all pass.
- `pnpm run auth:schema:check` -- expected: in sync.
