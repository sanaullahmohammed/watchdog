---
title: 'Story 4.6 — Push the public page when it changes'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: '87fbe7490efda8d265c22c9534254c4b59352f36'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A stream opened in 4.5 sends the page once and then only heartbeats. An integrator's page goes stale the moment anything public changes.

**Approach:** In the open-public-status-stream slice, a whitelisted hub event or a `resync` asks for the organization's page again. Compositions are coalesced per organization and go through `openPublicStatusEventStreamQuery`. Each stream is sent the result only when its `ETag` differs from the last page that stream was sent. The page is the gate (ARCHITECTURE 5.4, decided 2026-10-18), so drafts, hidden services and admin-only events change nothing a client sees.

**Decisions (owner, 2026-10-20):**
- Backpressure: the latest page wins. While a stream's socket has not drained, it is sent no page and no heartbeat. On `drain`, it is sent the newest composed page, if that page's ETag differs from the last one sent. A stream holds at most one page in its buffer. A slow reader is never cut off. A reader that never drains holds its place until its lifetime ends. This resolves deferred-work 4.5 #5.
- The spec stays whole (about 2,300 tokens).

## Boundaries & Constraints

**Always:**
- A pushed page is the same frame as the first one: `id: <ETag>`, then `data: <page JSON>`, with no `event:` line. It is built by the same query, presenter and `publicPageETag`.
- Coalesce per organization: at most one composition in flight, plus at most one queued. A composition runs only while the organization has an open stream in this app. Its result is offered only to streams that joined before it started, so a stream that joins while it runs is never sent an older page than its own first one.
- Only `event` and `resync` signals ask for a composition. The hub already keeps admin-only events off the public channel, and the route does not filter again.
- A failed composition is logged through the app logger, and the streams stay open on their last page. The next request tries again.
- Every write goes through the route's `send`. Leaving the push is part of the route's one idempotent cleanup.
- `app.close()` still resolves without waiting on clients. A composition in flight at close is awaited in an `onClose` hook, so it never outlives the pool.
- Integration tests run with only postgres, mailpit and migrate up.

**Never:**
- No `setNotFoundHandler`, no migration, and no edits to `docs/genesis` or `AGENTS.md`.
- No per-event payload on the public stream, no cursor, no replay. `Last-Event-ID` is still ignored.
- No unscoped worker pass in tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Public change | Open stream. Then a public incident is declared, an update posted, it is resolved, a window is scheduled or starts, or a visible service's status changes Once the change has settled (status recomputation can add a second push), the last frame's `data` equals `GET /status/:orgSlug` (ignoring `generatedAt`), and its `id` equals that `GET`'s `etag`. Every frame's `id` is the ETag of its own `data` |
| Hidden change | Draft created, edited, has an update posted, or is dismissed. Manual override on a private service. An incident naming only private services changes | No frame. The next public change's page is the next frame |
| Privacy-safe invalidation | A listed incident or window names one service, which is made private or archived. Or the window is deleted | The page without it, and without that service's id |
| Confirm | A draft is confirmed | The page lists it, and its timeline opens at the confirmation entry |
| Admin-only | `incident.draft_created`, `monitor.threshold_breached` | No composition |
| Burst | Several whitelisted events while one composition is held | Two compositions in all. Each stream gets the final page once |
| No streams | A whitelisted event for an org whose streams have all closed | No composition |
| Resync | `hub.resync()` after a change that sent no NOTIFY, with streams on two orgs | Each org composed. A stream whose page changed gets it, and the others get nothing |
| Backpressure | A stream's socket has not drained, and two more pages are composed | Nothing is written to it. On `drain`, it gets only the newest page, once. The heartbeat is skipped while it waits, and re-armed on `drain`. Proven in the unit spec: a real socket cannot be made to stall deterministically |
| Failure | Composition throws once | Logged. Streams stay open, and the next event pushes |
| Page gone | Recomposition answers the uniform `NotFoundException` (slug renamed or org deleted) | That org's streams end, as `GET` would now 404 |
| Gate (Constraint 11) | Remove the per-stream ETag comparison | The private-override row fails. The spec records that it did |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/queries/open-public-status-stream/open-public-status-stream.public.route.ts`:
  - The plugin closure makes one `admission` per app. The push goes beside it.
  - `send` and `cleanup` are the only write and end paths.
  - The hub callback today handles only `closed`.
  - Step 2 (`reply.raw.destroyed`) and the no-`await` window from step 2 to 6 must survive.
- `open-public-status-stream.handler.ts`: `openPublicStatusEventStreamQuery({ slug })` returns `PublicStatusPageView`. The route presents it with `toPublicStatusPage` and `publicPageETag` (api layer, so route-side only).
- `src/shared/realtime/realtime-hub.ts`:
  - `RealtimeSignal` is `event | resync | closed`.
  - Public subscribers get only `PUBLIC_EVENT_NAMES` (`event-visibility.ts`).
  - `resync()` reaches every public subscription of every org. Coalescing makes that one composition per org.
  - The hub has no org listing, and needs none.
- `src/server/plugins/realtime.ts`: `hub.close()` runs in `preClose`. Do not move it.
- `src/shared/exceptions`: `NotFoundException`, as thrown by `resolveOrganizationBySlug`.
- Events, from the investigation:
  - `transitionIncidentCommand` always emits `incident.state_changed`, which is admin-only. It emits `update_posted` only when `from !== 'draft'`, `confirmed` on draft → investigating, and `resolved` or `dismissed` on resolve.
  - A service made private emits only `service.updated`.
  - An override emits admin-only `manual_override_*`. Recompute then emits public `service.status_changed`, which is why the ETag comparison is the gate.
- `src/shared/testing/`:
  - `fixtures.ts`: `declareIncident`, `scheduleMaintenance`, `updateService`, `archiveService`, `transitionIncident`, `createService`. `insertDraftIncident` emits nothing. For a draft event, use `createDraftFromMonitorCommand`.
  - `notifications.ts`: `subscribeForOrg(hub, orgId).settle(app)` returns once the hub has delivered everything before it. `notifyRaw`.
- `src/server/build-app.ts:26`: `buildApp(overrides, { listen: true })` feeds the hub from real NOTIFYs.
- `public-status-stream.integration.test.ts`:
  - File-local helpers: `open`, `nextFrame`, `received`, `fields`, `withTimeout`, `withoutGeneratedAt`, `spawnApi`.
  - The 4.5 suite builds without `listen`, and its close test runs last.
- E2E:
  - `tests/support/server.ts` builds without `listen`.
  - `tests/status-page/public-status.{feature,steps.ts}` is the pattern: admin calls via `inject`, the visitor via `fetch(world.baseUrl…)`.
  - Config is in `cucumber.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] `queries/open-public-status-stream/public-page-push.ts` and `.spec.ts`:
  - `createPagePush({ compose, log })`, where `compose(slug)` resolves `{ frame, etag }`.
  - `join(orgId, { slug, etag, send, end })`, where `send` returns `raw.write`'s result, returns a member with `leave()`, and `drained()`, which the route calls on the socket's `drain`.
  - `request(orgId)` coalesces and offers the result to each member whose last `etag` differs.
  - `close()` drops every queued run, makes later `request()` calls no-ops, and resolves when the composition in flight settles.
  - A `NotFoundException` from `compose` calls each of that org's members' `end` (the route's `cleanup`, which ends the response gracefully), drops the queued run and clears the org's entry. Any other error is logged, and the members stay.
  - Pure and timer-free. The unit spec covers every coalescing, failure, no-member, leave-mid-composition and backpressure row.
- [x] `open-public-status-stream.public.route.ts`:
  - Create the push in the closure. `compose` executes the query and presents the result.
  - Register `onClose` → `push.close()`.
  - After the first write, `join` with the first page's ETag. If that write returned false, the member starts out waiting for `drain`.
  - `send` returns `raw.write`'s result. The heartbeat is skipped while `raw.writableNeedDrain`. On `raw` `drain`, call `member.drained()` and re-arm the heartbeat, even when no page is sent.
  - The hub callback calls `request(orgId)` on `event` and `resync`, and `cleanup` on `closed`.
  - `cleanup` calls `leave`.
  - Update the doc comment.
- [x] `authenticated-surface.spec.ts`: the stream's allowlist reason now says it pushes the page when it changes.
- [x] `public-status-stream.integration.test.ts`: a `describe` for 4.6, nested in the 4.5 `describe` and placed before its close test, with every matrix row except backpressure.
  - Its `before` builds a second app with `{ listen: true }` (and its own orgs) while the 4.5 app is still open. Its `after` closes that app and deletes its orgs. The 4.5 `after` stays the only `sql.end`.
  - Count and hold compositions by wrapping `app.queryBus.execute` for `openPublicStatusEventStreamQuery.type`. Reset the count after the streams open, so openings are not counted.
  - Filter everything by the test's own orgs, since a listening app hears every file's NOTIFYs. Orgs with no stream in this app compose nothing.
  - Draft events: `createMonitor`, then `createDraftFromMonitorCommand` through `app.commandBus` (it needs `orgId`, `monitorId`, `serviceId`, `monitorName` and `failureEpisode`).
  - A window that starts: insert it by SQL with a past `scheduled_start_at`, then execute `transitionDueMaintenanceCommand({ orgId })`, as `due-maintenance.integration.test.ts` does. A scheduled one: `scheduleMaintenance`.
  - Page gone: rename the slug by SQL, then send a whitelisted event with `notifyRaw`.
  - For a negative row, `settle`, await the held compositions, then make one public change and assert that its page is the next frame.
  - For resync, change a row by SQL inside `withTenantTransaction` with no event, then call `app.realtimeHub.resync()`.
  - Time anything with `performance.now()`.
- [x] `tests/support/server.ts`: build with `{ listen: true }`.
- [x] `tests/status-page/public-status-stream.feature` and `.steps.ts`: over a real socket, one incident, one maintenance and one service-status push, each checked against `GET`. The step text must not collide with `public-status.steps.ts`.
- [x] Gate mutation: remove the per-stream ETag comparison, run the private-override test, record that it fails, and restore the comparison.
- [x] `deferred-work.md`: mark the 4.5 #5 backpressure entry resolved by 4.6.

**Acceptance Criteria:**
- Given the gate mutation, when the ETag comparison is removed, then the private-override integration test fails. The result is recorded in Implementation Notes.
- Given streams open on two organizations, when one org's public change arrives, then only that org composes.

## Implementation Notes

- Gate mutation (2026-10-21): with the per-stream ETag comparison removed from `transmit` in `public-page-push.ts`, the integration test "sends no frame for a manual override on a private service", run alone, fails. It asserts that the override's recomposition ran (at least one composition) and that no frame followed. The comparison was restored and the test passes.

- Orchestrator patches (2026-10-20):
  - Requests in the tick a composition starts are covered by it, not queued behind it (`fresh` in `public-page-push.ts`). Otherwise an org with two streams composed twice per event, because the hub calls each stream's subscriber in one loop. Unit test added. Mutation: with `queued` always set, that test fails.
  - The hidden-change test counts frames from before the hidden changes, so a late stray frame is caught.
  - Pages in the 4.6 tests are typed `PublicStatusPageResponseDto`, which removes two new `any` warnings.
- Review patches (pass 1, triage #1, #2-3, #4, #7, #9, #10, #15, #19):
  - `compose` returns the page's org id. A miss, or another org's page, ends only the members on the composed slug, and the rest are composed again.
  - Members report `writable()`, so a page is held as pending whenever the socket needs draining, a full heartbeat included.
  - `run`'s rejection is logged.
  - The override is its own test.
  - The admin-only test has a positive control.
  - A test shows `app.close()` waits for a held composition.
  - The e2e step compares the page data and fails on a parse error.
- Gate re-run by the orchestrator, after the patches: with the ETag comparison removed, "sends no frame for a manual override on a private service", run alone, fails. Restored, it passes.
- Orchestrator verification, after the patches:
  - `pnpm run check`: clean (11 warnings, all pre-existing).
  - Unit: 313 of 313, with `.env` and without it.
  - Integration: 696 of 696, twice.
  - e2e: 7 of 7 scenarios.
  - Auth schema: in sync.
- Two-org AC: "composes only the org whose public change arrived, with streams open on two" counts compositions by slug (added by the orchestrator).

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-21). Layers: blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | Nothing tests that `app.close()` waits for a composition in flight (V) | medium | Pre-verified. Deleting the `onClose` hook keeps every test green. `hold()` already exists | patch (test) |
| 2 | Composing by slug can push another org's page after a rename and slug reuse (B, E) | medium | `run` composes `org.slug`, and `compose` never compares `view.organization.id` with the member's org. Better Auth allows slug updates (`auth.ts:96`), and slugs are unique, not permanent | patch |
| 3 | A miss ends every member, including one that joined on the renamed slug, and drops the run that would use it (B, E, V) | low | `run` ends `[...org.members]`, while `join` has already moved `org.slug` to the new slug. Same root as #2: the miss is judged per org, not per slug | patch (with #2) |
| 4 | A heartbeat that fills the socket is not seen by the push, so the next page is written into a full buffer (B, E) | medium | The route discards `send(HEARTBEAT)`'s result. `offer` checks only `state.waiting`, which only `transmit` sets. This breaks the owner's rule | patch |
| 5 | Several small pages can sit under the 16 KB highWaterMark (E) | low | True, but the buffer stays bounded by the highWaterMark plus one page, which is the bound the decision is about | reject |
| 6 | The route's backpressure wiring (drain listener, initial waiting, heartbeat guard, re-arm) is untested (V, B) | medium | Pre-verified. The unit spec drives only `createPagePush`. A real socket cannot be stalled deterministically; a route seam or fake `raw` is new test infrastructure | defer |
| 7 | No unit case for a member that joins waiting and gets a different page on `drained()` (B) | low | Only the equal-ETag drain case exists. Direct addition | patch (test) |
| 8 | Removing `member?.leave()` from cleanup fails no test (V) | medium | Pre-verified. A dead member is unobservable without a member count on the push, which is new surface | defer |
| 9 | The gate mutation fails at the first hidden change, so the override step is not isolated (B) | medium | Implementation Notes record exactly that. Nothing shows the override caused a composition | patch (split test, count compositions, rerun mutation) |
| 10 | The admin-only test has no positive control (B) | low | It asserts zero compositions, but never shows the events reached the hub. `subscribeForOrg` gives a direct control | patch (test) |
| 11 | The "No streams" integration row cannot fail on the push's own rule (B) | low | True: with no subscriber the hub never calls `request`. The row's outcome is still the one the matrix states, and the push rule is unit-tested | reject |
| 12 | A slug rename or org deletion emits no event, so the stream keeps its page until its lifetime (B) | low | No domain event exists for either; the lifetime bounds it at `PUBLIC_STREAM_MAX_LIFETIME_SECONDS`. Emitting one is new behaviour in another module | defer |
| 13 | The backpressure decision is not recorded in ARCHITECTURE (B) | low | ARCHITECTURE 5.4.1 records the stream's bounds. Editing `docs/genesis` needs the owner | defer |
| 14 | The burst test cannot tell coalescing from ETag suppression (B) | low | The test asserts one held composition and two in all, which is coalescing. Stale-then-newer ordering is in the unit spec | reject |
| 15 | The e2e push check compares only `id` with `GET`'s `etag`, and its bare `catch` hides parse errors (B) | low | `tests/status-page/public-status-stream.steps.ts`. Comparing the data and checking the id against its own data is a direct addition | patch (test) |
| 16 | The spec and sprint status disagree (B) | false | Step 3 sets the story `in-progress`, and step 5 moves it on. The spec is `in-review` during review by design | reject |
| 17 | An event between the opening snapshot and the subscribe is missed (E) | low | The accepted gap recorded in Design Notes | reject |
| 18 | A member that joined mid-composition is left out with nothing queued (E) | low | Missing a change requires an event before its subscribe, which is #17's accepted gap | reject |
| 19 | `run` can reject (a throwing `send` or `end`), leaving an unhandled rejection and a rejecting `close()` (E) | low | `org.running = run(...)` has no catch. Unlikely, but an unhandled rejection ends the process. A `.catch` that logs is direct | patch |
| 20 | A composition that never settles stops pushes and hangs close (E) | low | The same hang would hold any `GET`; no statement timeout exists anywhere. Not caused by this story | reject |
| 21 | `resync` composes every org with streams at once, which can crowd the pool (E) | medium | Up to one composition per org with open streams, each on the shared pool. Only on a LISTEN reconnect. A cap is a new policy | defer |
| 22 | The failure test's name says it logs, but the app has no logger (E) | low | The unit spec asserts the log entry, and the route passes `fastify.log` | reject |

## Design Notes

- **Compose by slug, key by org.** The hub keys on `orgId`, and the query takes a slug. The push stores the slug of the org's newest member. If the slug is renamed, the old slug's recomposition misses, and that org's streams end. Clients that reconnect get what `GET` gives them.
- **Accepted gap.** An event notified while a stream's first page is being composed, but before it subscribes, is not seen. That stream stays on its first page until the next public change or its lifetime ends. This is the same bound ARCHITECTURE 5.4 accepts for a lost NOTIFY.
- **No gap after the first write.** Steps 5 (first write), 6 (subscribe) and the `join` run in one tick, so an event cannot fall between them.
- **Why only earlier members get a result.** A composition that started before a member joined may hold an older snapshot than that member's first page, and its ETag would differ, so the member would be sent a page older than its own. A member that joins mid-flight is covered by the queued run whenever an event arrived after it subscribed.
- **Why the ETag comparison is per stream.** Streams join at different pages, so an org-wide "last page" would skip a stream that joined before a change.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration`, twice, with only postgres, mailpit and migrate up -- expected: all pass. Rerun any failure two or three times and report it.
- `pnpm run test:e2e` -- expected: all pass.
- `pnpm run auth:schema:check` -- expected: in sync.
