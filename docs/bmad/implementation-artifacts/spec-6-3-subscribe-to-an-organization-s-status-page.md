---
title: "Story 6.3: Subscribe to an organization's status page"
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: 'da5313a9d4dc67cb9c88c9fcf0a486aa43060eb0'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A visitor to a public status page cannot ask to be told about changes. FR21 needs a subscribe step that stores an address as `pending` and emails a confirmation link. DOMAIN (Subscriber) and ARCHITECTURE 5.4.1 and 5.6 bound how that step works.

**Approach:** Add the `subscribers` table (migration, RLS) and an anonymous `POST /status/:orgSlug/subscribers` slice in the `notification` module. It answers one identical 202 in every case, applies DOMAIN's state rules and the per-address throttle under a row lock, and sends a plain-text confirmation email through 6.2's `emailSender`. The link points to 6.4's route `GET /status/:orgSlug/subscribers/confirm?token=…`.

## Boundaries & Constraints

**Always:**
- Table `subscribers` as DOMAIN (Subscriber) specifies:
  - Columns: `id` uuid PK; `org_id` text not null, FK to `"organization"` on delete cascade; `email` text not null; `status` text with `subscribers_status_ck`; `confirmation_token_hash`, `confirmation_expires_at`, `confirmation_sent_at` and `confirmed_at`, all nullable; `created_at` and `updated_at`.
  - Keys: unique `subscribers_org_email_uk` on `(org_id, lower(email))`, and `unique (id, org_id)` for 6.6's composite FK.
  - RLS enabled and `FORCE`d. Policy `subscribers_org_isolation`, with no `is null` branch and no `coalesce`.
- Email, in two checks:
  - The slice's request schema is `{ email: string, 1–320 characters }`, so REST and the handler refuse the same raw input. It cannot hold the format, because ajv cannot trim and `"  a@b.c "` would fail it.
  - After `assertMatchesSchema`, the handler trims and lowercases. It then applies a second schema from `domain/subscriber-email.ts` to the result: one plain `local@domain` address (ajv's `email` format), at most 254 characters. A refusal is a 400 naming `email`.
  - Fastify strips an unknown body field (`removeAdditional`) rather than refusing it. That is accepted, as on every REST route.
- No refusal, exception or log line quotes the address (deferred-work, story 6.1 entry).
- Token: `randomBytes(32)`, base64url in the link, only its SHA-256 hex stored. `confirmation_expires_at` = now + `SUBSCRIBER_CONFIRMATION_TTL_HOURS`.
- State rules run in one tenant transaction:
  - Insert with `on conflict (org_id, lower(email)) do nothing`. If nothing was inserted, `select … for no key update` and apply the rules to the locked row. If that select finds no row (deleted in between), repeat the insert once. A second miss is a 500.
  - Every time comparison and every stored time uses the database's `now()` in SQL, never Node's clock. A request that waited on the lock then reads the row its rival just wrote. Tests set `confirmation_sent_at` in SQL.
  - A row is "throttled" when its `confirmation_sent_at` is within `SUBSCRIBER_CONFIRMATION_RESEND_SECONDS` of now. A throttled row changes nothing and is sent nothing, whatever its state.
  - A new row, or an unthrottled `pending` or `unsubscribed` row, becomes `pending` with a new token, expiry and `confirmation_sent_at`, and is sent one email.
  - A `confirmed` row changes nothing and is sent nothing.
- `subscriber.created` (`{ orgId, subscriberId }`, admin-only, not bridged) is emitted after the commit when a row is inserted, or when an `unsubscribed` row returns to `pending`. No email in any event payload.
- The answer is one identical 202 with `cache-control: no-store` for every accepted request. The body is `{ "message": "If this address is not already subscribed, a confirmation email is on its way." }`.
- Limits: the route's own per-IP limit of `SUBSCRIBE_RATE_LIMIT_MAX` (default 5) per `SUBSCRIBE_RATE_LIMIT_WINDOW_MS` (default 3,600,000). The route takes one limiter, so 5.4.1's bound is kept by a boot check: boot fails, naming the variables, unless `SUBSCRIBE_RATE_LIMIT_MAX` ≤ `PUBLIC_RATE_LIMIT_MAX` and `SUBSCRIBE_RATE_LIMIT_WINDOW_MS` ≥ `PUBLIC_RATE_LIMIT_WINDOW_MS`. A 429 carries `Retry-After`, set by `@fastify/rate-limit`, and the public headers.
- `publicHeaders` in the route's `onSend` on every answer, including 400, 404 and 429. An `OPTIONS` preflight, not rationed, answers 204 with `access-control-allow-methods: POST, OPTIONS`, `access-control-allow-headers: content-type`, and no credentials.
- Unknown or malformed slug: the uniform miss, through a notification-owned `organization` read with `isSlug`, `PUBLIC_PAGE_NOT_FOUND` and `NotFoundException`.
- Email: subject `Confirm your subscription to <org name> status updates`. Plain-text body: one sentence on what confirming does, the link, the hours it stays valid, and "If you did not ask for this, ignore this email; nothing more will be sent."
- No `List-Unsubscribe` on the confirmation email: the address has not subscribed yet, and ignoring the email ends it. ARCHITECTURE 5.6's general line "Every email carries a `List-Unsubscribe` header" is reworded to "Every notification email…", so it agrees with the detailed rule (owner decision 2026-10-21).
- The email is sent after the answer: the handler commits, starts the send without awaiting it, and the route answers 202 at once, so the answer takes the same time whether or not an email goes out. Sends in flight are tracked by a notification singleton with `drain()`. The `.public.route.ts` plugin awaits it from its own `onClose` hook, so `app.close()` never cuts one off. The send path and its failure log touch no database, because the connection may close beside `fastify.close()` (`src/api.ts`). Tests `drain()` before reading Mailpit or asserting that nothing was sent (owner decision 2026-10-21).
- A failed send still answers 202, and `confirmation_sent_at` stays set, so the address is throttled for the resend window even though no email arrived. That is accepted: DOMAIN stamps the time an email is queued, not delivered. It is logged at `warn` with `orgId`, `subscriberId` and the sender's `diagnostic`, never the address or the token.
- New settings in `notification-env.ts`, with defaults, so `pnpm run test` passes with `.env` moved aside.

**Never:**
- No confirm or unsubscribe route, link signing or `NOTIFICATION_LINK_SECRET`. Those belong to 6.4.
- No GraphQL, and no admin list of subscribers.
- No address-revealing difference in the answer: status, headers and body are byte-identical across states.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New address | `{ email: "  Ann@X.test " }` | 202. Row `pending`, `ann@x.test`, hash, expiry, sent_at. One email in Mailpit with the link under `PUBLIC_BASE_URL`. `subscriber.created` emitted | N/A |
| Pending, unthrottled | sent_at older than resend window | Same 202. New hash (old one replaced), one new email. No event | N/A |
| Unsubscribed, unthrottled | | Same 202. Row back to `pending`, new token, one email, `subscriber.created` | N/A |
| Confirmed | | Same 202. Row unchanged, no email, no event | N/A |
| Throttled (any state) | sent_at within the resend window | Same 202. Row unchanged, no email, no event | N/A |
| Two first-time requests at once | same address | Both the same 202. One row, one email | No unique violation reaches the client or the logs |
| Bad slug | unknown or malformed | Uniform 404 miss with public headers | |
| Bad address | not an address, over 254 characters after trimming, over 320 raw, missing | 400 that does not echo the value | |
| Bad address, unknown slug | both | 400: the body is validated before the slug is read. The same for every slug, so it reveals nothing | |
| Sixth request in the window | same IP | 429, with `Retry-After` exposed through the public headers | |
| Send fails | sender returns `transient` or `permanent` | Still 202; row stays `pending` with sent_at set | `warn` log with no address and no token |

</frozen-after-approval>

## Code Map

- `db/migrations/20261017120000_create_uptime_rollups.sql` -- the pattern for a tenant table: FK `references "organization" ("id") on delete cascade`, RLS enabled and forced, `<table>_org_isolation` policy, a named `_ck` check. Grants come from default privileges (`20260910053718_grant_watchdog_app.sql`), so do not grant per table. The newest migration is `20261017150000_…`.
- `src/modules/maintenance/commands/schedule-maintenance/*.handler.ts` -- handler shape: `make…({deps}: Dependencies)`, `{ handler, init(){ commandBus.register } }`. Order: `assertMatchesSchema`, then `withTenantTransaction`, then `eventBus.emit` after it resolves. The action creator comes from the module's `index.ts`.
- `src/modules/maintenance/database/maintenance.repository.ts` -- a repository taking `tx: TenantTransaction` per call. DI picks up `*.repository|service|domain|handler` (`src/server/di/index.ts`). `emailSender` is registered by hand there.
- `src/modules/notification/index.ts` -- add `notificationActionCreator` and the new `Dependencies` entries.
- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts` -- `config.rateLimit`, `publicHeaders` in `onSend` (`src/shared/api/public-surface.ts`), and the explicit `OPTIONS` route at lines 106-117. Its catch-all `/status/*` (142-157) would answer the OPTIONS with 404 unless this slice declares its own. Do not copy the ETag or 304 logic.
- `src/modules/status-page/database/organization.repository.ts:26-31` -- the slug read on the global `sql` (`"organization"` is outside RLS). Copy it into notification; do not import across modules.
- `src/shared/domain/slug.ts` (`isSlug`), `src/shared/domain/public-page-miss.ts` (`PUBLIC_PAGE_NOT_FOUND`).
- `src/server/plugins/error-handler.ts:13-21` -- a body-schema 400 lists the path and ajv's message, never the value.
- `src/shared/events/maintenance.events.ts` -- the event file pattern. `src/shared/realtime/realtime-event.spec.ts` already lists `subscriber.created` as unbridged. Add `subscriber.events.ts` to its `IMPORTED_EVENT_FILES`. Do not touch `PUBLIC_EVENT_NAMES` or `BRIDGED_EVENTS`.
- `src/config/notification-env.ts`, `src/config/env.ts` -- add the four settings and export `env.subscribe`. Mirror `PUBLIC_RATE_LIMIT_*` (`env.ts:51-52`).
- Contract specs:
  - `src/shared/api/contract/api-surface-parity.spec.ts:167`: `REST_ONLY_BY_DESIGN`, key `'notification/commands/create-subscriber'`.
  - `authenticated-surface.spec.ts:46`: `PUBLIC_BY_DESIGN`, keys `'POST /status/:orgSlug/subscribers'` and `'OPTIONS …'`, with literal `method` and `url`.
  - `src/shared/db/foreign-table-allowlist.spec.ts`: `OWNED.notification: ['subscribers']` and `FOREIGN.notification: ['organization']`.
- Test helpers:
  - `src/shared/testing/tenant.ts:40` `signUpWithOrg` (slug = label).
  - `mailpit.ts` `uniqueRecipient` and `messagesTo`.
  - `events.ts` `capturing`.
  - `logs.ts`.
  - To override a singleton, resolve it from `app.diContainer` and patch `send`, restoring it in `finally`.
  - The lock-race pattern is in `src/modules/incident/incident-concurrency.integration.test.ts:205-235`.
  - The rate-limit test pattern is in `src/modules/status-page/public-surface-bounds.integration.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `db/migrations/20261021120000_create_subscribers.sql` -- the table, keys, RLS and policy; the down step drops it.
- [x] `src/config/notification-env.ts` (+ spec), `src/config/env.ts`, `.env.example` -- `SUBSCRIBE_RATE_LIMIT_MAX` (5, min 1), `SUBSCRIBE_RATE_LIMIT_WINDOW_MS` (3,600,000, min 1,000), `SUBSCRIBER_CONFIRMATION_TTL_HOURS` (24, min 1), `SUBSCRIBER_CONFIRMATION_RESEND_SECONDS` (600, min 0). The spec covers the defaults and the limit boot check.
- [x] `src/shared/events/subscriber.events.ts` -- `subscriberCreatedEvent`. In `realtime-event.spec.ts`, add `import * as subscriberEvents` to `EXPORTED_CREATORS` (lines 81-90) and `'subscriber.events.ts'` to `IMPORTED_EVENT_FILES`.
- [x] `src/modules/notification/domain/confirmation-token.ts` -- generate a token and its hash. `domain/subscriber-email.ts` -- the normalised-address schema. `domain/confirmation-email.ts` -- builds the subject, the text and the link from the org name, slug, token, TTL and `PUBLIC_BASE_URL`.
- [x] `docs/genesis/ARCHITECTURE.md` (5.6, the "anonymous subscribe route" bullet) -- "Every email carries" becomes "Every notification email carries" (owner-approved edit, 1A). First, before any code.
- [x] `src/modules/notification/commands/create-subscriber/confirmation-sends.service.ts` -- not in `domain/`, which dependency-cruiser keeps free of application code. DI registers it as `confirmationSendsService`; declare it in `index.ts`. The in-flight send tracker: `track(promise)`, `drain()`. A tracked send that rejects is caught and logged without the address.
- [x] `src/modules/notification/database/organization-by-slug.repository.ts`, `subscriber.repository.ts` -- the slug read, and the insert-or-lock plus update.
- [x] `src/modules/notification/commands/create-subscriber/` -- `.schema.ts`, `.handler.ts` and `.public.route.ts` (POST plus OPTIONS).
- [ ] The three contract specs -- the allowlist entries, each with its reason.
- [x] `src/modules/notification/create-subscriber.integration.test.ts` -- every matrix row, the throttle per state, RLS isolation from a second org, the CORS preflight, and two races: two first-time requests, and two requests for an unthrottled `pending` row. Each race yields one email.

**Acceptance Criteria:**
- Given the migration, when `tenant-rls-coverage.integration.test.ts` runs, then it passes with `subscribers` included.
- Given the 202 for each state, when the status, headers (less date and correlation-dependent ones) and body are compared, then they are identical.
- Given the row lock removed from the repository, when the pending-race test runs, then it fails (two emails), and Implementation Notes record it (Constraint 11). Likewise for the throttle check removed, and for normalization removed.
- Given `.env` moved aside, when `pnpm run test` runs, then it passes.

## Implementation Notes

Mutation checks (acceptance criterion 3), each run against `create-subscriber.integration.test.ts` and then reverted:
- Row lock removed (`for no key update` dropped from the repository): `sends one email when an unthrottled pending address is requested at once` fails (two or more emails).
- Throttle check removed (`row.throttled` dropped): `changes nothing and sends nothing inside the resend window, in any state` and both race tests fail.
- Normalization removed (handler uses the raw address): `stores a new address trimmed and lowercased, and emails the link` fails.

- Review fixes (pass 1, Triage Log rows marked patch):
  - The four settings are `Type.Integer`. TTL is capped at 8,760 hours, the resend window at 86,400 seconds. Fractions and values over each cap are refused in `notification-env.spec.ts`.
  - `src/config/subscribe-limits.integration.test.ts` spawns `src/index.ts api` with `SUBSCRIBE_RATE_LIMIT_MAX=11` and `PUBLIC_RATE_LIMIT_MAX=10`, and expects a non-zero exit naming both variables. With `assertSubscribeLimits(env)` deleted from `env.ts`, it fails (checked, then restored byte for byte).
  - The handler's raw-schema test also runs `42` and 330 spaces plus `a@b.test` through the command bus; each is an `ArgumentInvalidException` (400).
  - `confirmationSendsService` logs an unexpected rejection at `error`, with neither the error nor the address. `confirmation-sends.service.spec.ts` pins `drain()` waiting, including for a send tracked while it waits, and the rejection path.
  - A new integration case stubs a 300 ms send, posts, and calls `close()` without draining; the send settles first. With the route's `onClose` hook deleted, it fails (checked, then restored byte for byte).
  - The send-fails test counts only its own two subscribers' warnings. The identical-answer test compares `content-length` too.
  - `confirmation-email.spec.ts` and `confirmation-token.spec.ts` pin the subject, the link's exact shape, "1 hour" and "24 hours", plain text only, and a 43-character base64url token whose 64-hex SHA-256 is stored.
- The first full integration run had one failure outside this story: `monitor.integration.test.ts`, "an enabled-only change announces monitor.updated, and updated_at moves only on a change" (`updated_at did not move`). Rerun alone three times and in the full suite twice, it passed every time. That fits the WSL clock stepping back (AGENTS.md).

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-21). Reviewers: blind-hunter (B), edge-case-hunter (E), verification-gap (V).

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | B1/E1/E2: the four subscribe settings are `Type.Number`, with no upper bound on the TTL or the resend window | medium | `make_interval(hours => ${ttlHours})` takes an integer, so a TTL of `1.5` fails every subscribe with a 500, and a huge resend value overflows the interval | patch |
| 2 | B2: ARCHITECTURE 5.6 says "besides 5.4.1's bounds" (two limits), but the code has one limiter plus a boot check | low | The behaviour keeps both bounds; only the wording differs. A genesis edit needs the owner's OK | defer |
| 3 | B3/E5: the database work before the 202 differs by state (an insert, or an insert plus a lock, or an insert, a lock and an update), so timing could separate states | low | Real, but each difference is sub-millisecond database work, under network jitter, and the 5-an-hour limit stops an IP sampling enough requests to average it out. Equalising the work restructures the repository. The send, the part 2A decided, is off the answer path | reject |
| 4 | V1: nothing proves `env.ts` calls `assertSubscribeLimits` | low | Pre-verified gap: deleting `src/config/env.ts:115` passes every test | patch |
| 5 | V2: the handler's raw-schema test uses `'nope'`, which the second schema also refuses | low | Pre-verified gap: deleting the handler's raw `assertMatchesSchema` passes the test, and `42` then becomes a TypeError (a 500) | patch |
| 6 | B4: behind a proxy every visitor shares one 5-an-hour bucket, and an IPv6 /64 gets fresh buckets | medium | `trustProxy` is off and the key is the socket address, a choice the whole public surface made before this story (ARCHITECTURE 5.4.1, F-18) | defer |
| 7 | B5: no global or per-organization budget on confirmation emails | low | Owner decision D7 sets the bounds (per IP, per address). A budget is a new rule | defer |
| 8 | V3/B8: `drain()` and the rejection branch are untested, and an unexpected rejection is logged at `warn` | low | Pre-verified gap: making `drain()` resolve at once would let the "nothing sent" and race tests pass vacuously. An unexpected fault is `error` under `logFailure`'s convention | patch |
| 9 | V4: nothing proves `app.close()` waits for a send in flight | low | Pre-verified gap: deleting the route's `onClose` passes every test, because each test drains by hand | patch |
| 10 | E6: a request in flight during `close()` can call `track()` after `drain()` returned | false | Fastify registers the server close in an `onClose` at `preReady`, after every plugin. avvio runs `onClose` last-in, first-out, so `server.close()` waits for requests in flight before the route plugin's drain runs (`node_modules/fastify/fastify.js:375-409`) | reject |
| 11 | E3: a resend window longer than the TTL blocks a new link after expiry | low | Real only when configured that way; the defaults are 600 s and 24 h. The fix adds a boot rule | reject |
| 12 | E4: an organization deleted between the slug read and the insert gives a 500 (FK violation) instead of the miss | low | A race against deleting an organization; the fix adds a branch | reject |
| 13 | E7: the throttle tests fail with `SUBSCRIBER_CONFIRMATION_RESEND_SECONDS` 0 or 1 in a developer's `.env` | low | Valid but unusual local setting; CI uses the defaults. The fix adds skips | reject |
| 14 | E8: the send-fails test counts every `confirmation email not sent` line in the shared capture | low | An earlier test's real send returning transient would make it 3. Filtering by the test's own ids is direct | patch |
| 15 | B6: emails sent before 6.4 ships carry a dead link | low | Stories ship to master in order and v1 has no release between 6.3 and 6.4 | reject |
| 16 | B7: the token in `?token=` will reach the request log once 6.4 serves the route | low | Story 6.4's AC owns it ("no log line carries a token… query string is redacted"), and deferred-work already targets 6.4 | reject |
| 17 | B9: no unit specs for the pure domain code | low | The singular "1 hour" branch and the link shape are unpinned. Adding specs is direct | patch |
| 18 | B10: the migration does not enforce normalisation or state coherence, and has no token-hash index | low | DOMAIN asks for neither constraint. 6.4 and 6.9 add the indexes their queries need. The fix adds guards | reject |
| 19 | B11: the identical-answer test strips `content-length` | low | The bodies are identical, so it can be compared. Keeping it is a deletion | patch |
| 20 | B12: sprint status and spec disagree; a task is unticked | false | step-05 moves sprint status to `review`; every task is now ticked | reject |

## Verification

**Commands:**
- `pnpm run check` -- passes
- `pnpm run test`, with `.env` present and moved aside -- passes
- `docker compose up -d` (postgres, mailpit and migrate only), then `pnpm run test:integration` -- passes
- `pnpm run test:e2e` -- passes
- `pnpm run auth:schema:check` -- passes
