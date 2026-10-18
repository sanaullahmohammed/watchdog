# Epic 4 Context: Live updates

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Public and admin surfaces update without a refresh: SSE for public status pages and GraphQL subscriptions for the admin dashboard, both fed across processes by a Postgres `LISTEN/NOTIFY` backplane. It is delivered after Epic 5, so the worker's monitor events are the real cross-process case the Compose test proves. It also finishes the existing public route (CORS and HEAD gaps) before the stream inherits its behaviour, and closes the four story-9.12 deferred-work entries aimed at this epic.

## Stories

- Story 4.1: Every answer under /status/ carries the public headers
- Story 4.2: HEAD revalidation answers 304
- Story 4.3: Bridge domain events to NOTIFY
- Story 4.4: Listen in the api and fan out per organization
- Story 4.5: Open a public status stream
- Story 4.6: Push the public page when it changes
- Story 4.7: Subscribe to organization events over GraphQL
- Story 4.8: Close a subscription when access is lost
- Story 4.9: Prove worker events reach api clients under Compose

## Requirements & Constraints

- Public SSE, admin GraphQL subscriptions and the cross-process backplane must each be proven end to end: SSE delivery after domain events, subscription events for incident and service changes, and a worker-originated event reaching an api client.
- The public stream sends the page, not events. A client receives the document `/status/:orgSlug` returns, once on open and again whenever it changes. A whitelisted event only triggers recomposition; a page is sent only if its `ETag` differs from that stream's last. This applies the whole public-page visibility rule by construction (drafts private, only public unarchived services, incidents/windows naming only hidden services dropped, no hidden affected-service ids), including when a service is made private or archived or a window is deleted.
- Admin-only events (e.g. `incident.draft_created`, `monitor.threshold_breached`, `uptime.rollup_refreshed`, manual overrides) never trigger a composition and never reach a public client, even as timing. Uptime bars are not live; they arrive with the next push or on reopen.
- The admin subscription carries signals only (`eventName`, `aggregateType`, `aggregateId`, `occurredAt`) for every bridged event of the subscriber's active organization, admin-only ones included; clients re-read through ordinary queries. GraphQL subscriptions are admin-only.
- The anonymous surface keeps its four bounds: one `publicStatusPage` per GraphQL operation, per-IP rate limit, cache validators, CORS for any origin without credentials. For the stream: openings are rate-limited by IP; `Cache-Control: no-store` and no stream `ETag` (each pushed page's `ETag` is the SSE `id`); CORS preflight admits `Last-Event-ID`, which is otherwise ignored.
- Streams are capped and expire: `PUBLIC_STREAM_MAX_PER_IP` (10), `PUBLIC_STREAM_MAX_TOTAL` (1,000 per api process), `PUBLIC_STREAM_MAX_LIFETIME_SECONDS` (3,600). Excess answers the same `TooManyRequestsException` 429. Closing the app ends all streams and subscriptions.
- Admin subscription access: session, active organization and membership are resolved at open and re-checked every `ADMIN_SUBSCRIPTION_RECHECK_SECONDS` (60); loss of access disconnects within that. The upgrade is refused unless `Origin` is `BETTER_AUTH_URL` or a trusted origin, and an upgrade without a valid session is `UNAUTHENTICATED` and counts against the anonymous `/graphql` limit (decided by resolving the session, never by cookie presence).
- No durability: `NOTIFY` is a signal. A lost one leaves a stream on its last page until the next public change or its lifetime end; an admin client sees the change on its next read or after `resync`. No cursors, no replay.
- Story-level rules (epics file): one module per story, a named test-gate mutation check for fixes (Constraint 11), deferrals state their premise.

## Technical Decisions

- Channel `watchdog_events`; payload `{ eventName, orgId, aggregateType, aggregateId, occurredAt, version: 1 }`, kept small. Only events the catalog marks for bridging are sent. The in-process bus uses `<prefix>/<name>`, the wire and catalog use `<prefix>.<name>`; the bridge translates.
- Both `api` and `worker` bridge (a bus handler in every app instance); only the `api` listens. The worker opens no `LISTEN` connection. The bus delivers to every handler of a type, isolates handler failures, and does not retry.
- Bridge, listener and hub are infrastructure in `src/shared/realtime/` (they read no tenant table, decide nothing about the domain); the admin subscription lives in `src/server/realtime/` beside the GraphQL wiring; the public stream is a `status-page` slice (it composes that module's page via the same query and `public-page.ts` visibility rule inside `withTenantTransaction`).
- Compositions are coalesced per organization (one in flight plus at most one queued) and run only while the organization has an open stream. A failed composition is logged; streams stay open and the next event retries.
- When the api's `LISTEN` connection is re-established, every open stream is recomposed and every admin subscription gets a `resync` event.
- Public whitelist (necessary, not sufficient): service, service_group, incident (created, confirmed, updated, update_posted, resolved) and maintenance events. Draft-gated events (`incident.created/updated/update_posted`) depend on the incident not being a draft; draft dismissal emits `incident.dismissed` only.
- Contract specs: `api-surface-parity.spec.ts` gets a named REST-only exemption for the stream (4.5, recorded in ARCHITECTURE 7.1); `PUBLIC_BY_DESIGN` gains `GET /status/:orgSlug/events` and its `OPTIONS`; `authenticated-surface.spec.ts` is extended to read `src/server/realtime/` (4.7).
- Conventions that bite: every error a client reads is an `ExceptionBase` (or `ErrorWithProps`) or it is masked as 500; `@fastify/rate-limit` needs `isExceeded` and an `ExceptionBase` from `errorResponseBuilder`; `/status/:orgSlug` misses must stay uniform; new config only through `src/config/` and `.env.example`; tests must wait for async work (`app.eventBus.drain()`), never run an unscoped worker pass, and close apps cleanly.
- CI: a new `compose` job builds the image, runs `docker compose --profile app up` against its own stack, and runs `test:compose` (glob quoted) on every pull request. Locally it needs the `app` profile that the integration suites need down. Epic 8's container smoke test builds on it.

## Cross-Story Dependencies

- Strict order. 4.1-4.2 harden the existing public route first; 4.3 (send) and 4.4 (receive, hub, resync) are the backplane; 4.5 opens the stream and 4.6 pushes pages through it; 4.7 opens the admin subscription and 4.8 adds its access re-check; 4.9 proves the whole path across processes.
- 4.3's `src/shared/testing/notifications.ts` listener helper is reused by 4.4 and 4.9; 4.7 adds a subscription client helper to `src/shared/testing/graphql.ts`.
- 4.1 closes three 9.12 CORS deferrals (router-answered misses, malformed percent-encoding, `Retry-After`); 4.2 closes the HEAD 304 one. The 5.13 `sequence`-as-cursor note is retargeted to Epic 6 (notification pass).
- Depends on Epic 5 for worker-originated monitor events; touches `status-page`, `incident`, `service` data only through events and the page query, never by cross-module imports.
