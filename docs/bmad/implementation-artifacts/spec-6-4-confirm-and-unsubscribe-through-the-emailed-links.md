---
title: 'Story 6.4: Confirm and unsubscribe through the emailed links'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '4fc406f16bee069baeef0d3266bbb0e5ad90898c'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.3 emails a confirmation link to `GET /status/:orgSlug/subscribers/confirm?token=…`, but nothing serves it. A subscriber also has no way to stop. FR21 needs both. DOMAIN (Subscriber) and ARCHITECTURE 5.6 fix the rules: links act on GET, answers are plain text, the unsubscribe link is signed rather than stored, and unsubscribe also takes RFC 8058's one-click POST.

**Approach:** Two REST-only public slices in `notification`, `commands/confirm-subscriber/` and `commands/unsubscribe/`, over the existing `subscribers` table, with no migration. Add `domain/unsubscribe-link.ts` (sign, verify, build) and `NOTIFICATION_LINK_SECRET`, and strip the query string from Fastify's request log.

## Boundaries & Constraints

**Always:**
- Routes:
  - `GET /status/:orgSlug/subscribers/confirm?token=…`.
  - `GET` and `POST /status/:orgSlug/subscribers/unsubscribe?subscriber=…&signature=…`.
  - Each route is rationed by `env.publicSurface.rateLimit`, carries `publicHeaders` in `onSend` and `cache-control: no-store`, and answers `text/plain; charset=utf-8`. There is no `OPTIONS` route: a link is a navigation, and one-click POSTs come from mail servers. These two differences from 5.4.1's bounds are decided here: links that change state are never cached (`no-store`, no validators) and are not read cross-origin. They are recorded for the owner in deferred-work (task below).
  - Each GET is one route with `method: ['GET', 'HEAD']`, so HEAD shares the GET's rate-limit bucket, as on the page route.
- Confirm runs in the slug's tenant transaction as one `update … where confirmation_token_hash = <sha256(token)> and status = 'pending' and confirmation_expires_at > now() returning id`. It sets `status = 'confirmed'`, `confirmed_at = now()`, `confirmation_token_hash = null` and `updated_at = now()`. A row returned means 200 `Your subscription to <org name> status updates is confirmed.`, plus `subscriber.confirmed` emitted after the commit. Two concurrent confirms produce one success and one event.
- Unsubscribe:
  - The signature is base64url (no padding) of HMAC-SHA256, keyed by `NOTIFICATION_LINK_SECRET`, over `unsubscribe\n<orgId>\n<subscriberId>`; the leading label keeps a later link type signed with the same secret from unsubscribing (owner decision 2026-10-22, review row 1, option A). It is verified with `timingSafeEqual` after a length check, before any subscriber SQL.
  - Comparison: recompute the base64url string, check that it has the same length as the supplied one, then `timingSafeEqual` their UTF-8 bytes. Comparing strings, not decoded bytes, refuses the alternative spellings 43 characters allow.
  - On a valid signature, in the tenant transaction, `select id, status … for no key update`. If no row, the uniform answer.
  - Otherwise, any state not `unsubscribed` becomes `unsubscribed`, with `confirmation_token_hash = null` (so an old confirm link dies) and `updated_at = now()`, and `subscriber.unsubscribed` is emitted after the commit.
  - An already-unsubscribed row changes nothing and emits nothing.
  - Both answer 200 `You are unsubscribed from <org name> status updates.`
  - The POST does the same. Its plugin calls `removeAllContentTypeParsers()` and adds one `'*'` parser that discards the body (`parseAs: 'string'`, `bodyLimit: 1024`). Encapsulated, this leaves every other route's parsers alone. So any content type, including none, `application/json` and RFC 8058's `application/x-www-form-urlencoded` or `multipart/form-data`, is accepted, and the body is ignored, because the signed query string is the authority. A body over 1 KiB gets Fastify's JSON 413 with the public headers. That is accepted.
- The uniform answer: 404, `text/plain`, `This link is not valid. It may have expired or already been used.` It is given for:
  - an unknown or malformed slug (the text, not the page's JSON `PUBLIC_PAGE_NOT_FOUND`);
  - a missing or malformed `token`, `subscriber` or `signature`;
  - an unknown, expired or already-used token, or a token of a non-`pending` row;
  - a wrong signature, or a signature for another organization;
  - a subscriber that does not exist in this organization.

  Each route gives it byte-identical, and nothing changes. Each slice's `.schema.ts` holds its query rules: `token` matches `^[A-Za-z0-9_-]{43}$`; `subscriber` is a uuid; `signature` matches `^[A-Za-z0-9_-]{43}$`. The handler applies it with `assertMatchesSchema`, and the route turns that refusal and the slug miss into the uniform answer. No route-level querystring schema exists, so a malformed query never becomes a JSON 400.
- A `HEAD` looks nothing up and changes nothing. Whatever the link, it answers 200 `text/plain` with an empty body, so a link scanner's HEAD consumes no token and learns nothing. (A scanner's GET confirming is accepted for v1, ARCHITECTURE 5.6.)
- `domain/unsubscribe-link.ts` exports `signUnsubscribe(secret, orgId, subscriberId)`, `verifyUnsubscribe(secret, orgId, subscriberId, signature)`, which never throws, and `unsubscribeLink(publicBaseUrl, orgSlug, orgId, subscriberId, secret)` for story 6.7. It takes the secret as an argument and imports no config.
- `NOTIFICATION_LINK_SECRET` is required, at least 32 characters, with no default, like `BETTER_AUTH_SECRET`; boot fails without it, naming it and quoting nothing (owner decision 2026-10-21, 1A). Compose's api and worker get `${NOTIFICATION_LINK_SECRET:-<dev value of at least 32 characters>}`, `.env.example` a dev value, and CI's database job a test value. `env.notificationLinkSecret` exposes it.
- Request logs: a `req` serializer (`src/shared/db/sql-debug.ts`) logs Fastify's default fields with `url` cut at the first `?`, for every route. The defaults are `method`, `url`, `version` from `headers['accept-version']`, `host`, `remoteAddress` from `req.ip`, and `remotePort` from `req.socket.remotePort`. `appLoggerOptions` puts it before the caller's serializers (`{ req, ...options.serializers, err, error }`), so a caller's own `req` still wins, as `sql-debug.spec.ts:135-144` requires, and only `err` and `error` stay forced. `scrubbedLoggerOptions` gets it too. So `incoming request` and `request completed` never carry a token or signature.
- Events `subscriberConfirmedEvent` and `subscriberUnsubscribedEvent` (`{ orgId, subscriberId }`, admin-only, not bridged) go in `src/shared/events/subscriber.events.ts`.

**Never:**
- No migration and no new column. No GraphQL. No `List-Unsubscribe` on any email yet: notifications arrive in 6.7, and the confirmation email has none (6.3, decision 1A).
- No token, signature or address in any log line, exception message or answer.
- No delivery cancellation; deliveries arrive in 6.6.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Confirm | pending row, link from Mailpit | 200 text; row `confirmed`, `confirmed_at` set, hash null; one `subscriber.confirmed` | N/A |
| Confirm again, expired, unknown, other org's token, non-pending row | | Uniform 404 text; row unchanged; no event | |
| Confirm twice at once | same token | One 200, one uniform 404; one event | |
| Unsubscribe GET or POST | valid signed link, confirmed or pending row | 200 text; row `unsubscribed`, hash null; one `subscriber.unsubscribed` | N/A |
| Unsubscribe again | already unsubscribed | Same 200 text; no event | |
| Unsubscribe twice at once | same link | Both 200 text; one event | |
| Wrong signature, other org's subscriber, deleted subscriber | | Uniform 404 text; nothing changes | |
| Malformed or missing query, unknown or malformed slug | | Uniform 404 text | No JSON 400 |
| One-click POST | `List-Unsubscribe=One-Click` as urlencoded or multipart; or no body and no content type; or `application/json` with an empty body | As the GET | Not a 400 or 415 |
| HEAD on either link | valid or invalid link | 200, empty body; nothing changes | |
| Logs | any of the above | No line contains the token or signature | |

</frozen-after-approval>

## Code Map

- `src/modules/notification/commands/create-subscriber/` -- 6.3's slice. Copy its handler shape (`notificationActionCreator`, `init`), `onSend: publicHeaders` and `config.rateLimit`. Its `.public.route.ts` shows a second route in one file.
- `src/modules/notification/database/subscriber.repository.ts` -- add `confirm(tx, tokenHash)` and `unsubscribe(tx, subscriberId)`. Use `now()` in SQL, as `requestConfirmation` does.
- `src/modules/notification/database/organization-by-slug.repository.ts` -- `findBySlug`. `src/shared/domain/slug.ts` -- `isSlug`.
- `src/modules/notification/domain/confirmation-token.ts` -- `hashConfirmationToken`.
- `src/modules/notification/domain/confirmation-email.ts:20` -- the confirm link 6.3 already sends; the path is fixed.
- `src/shared/events/subscriber.events.ts` -- add the two creators. `src/shared/realtime/realtime-event.spec.ts:66-68` already lists them as unbridged and imports the file, so nothing else changes there.
- `src/shared/db/sql-debug.ts:233` `LOG_SERIALIZERS` (`err`, `error`) -- the `req` serializer goes into `appLoggerOptions` and `scrubbedLoggerOptions`, before the caller's serializers (see Boundaries); keep `sql-debug.spec.ts:135-144` passing. The serializer's unit test builds a Fastify-like request (`host`, `ip`, `socket.remotePort`, `headers`). `appLoggerOptions` (:346-373) and `scrubbedLoggerOptions` (:330) both spread it. Fastify's default `req` serializer (`node_modules/fastify/lib/logger-pino.js:47-55`) logs `method`, `url`, `version`, `host`, `remoteAddress` and `remotePort`; keep them. `redact` paths cannot cut a string.
- `src/shared/testing/logs.ts` `captureLogs()` -- keep `incoming request` and `request completed` lines when asserting.
- Fastify 5 adds an automatic HEAD route that runs the GET handler (`exposeHeadRoutes`). Declare `HEAD` yourself on the GET routes, as `get-public-status-page.public.route.ts` does.
- No form-body parser is registered. Add `fastify.addContentTypeParser([...], { parseAs: 'string', bodyLimit: 1024 }, …)` inside the unsubscribe route file (encapsulated, not `fp`).
- The error handler always answers JSON, so the route catches `ArgumentInvalidException` and `NotFoundException` from its own command and replies with the uniform text itself. Anything else propagates (a 500). The limiter's 429 stays JSON with the public headers, as on every public route.
- Contract specs:
  - `src/shared/api/contract/api-surface-parity.spec.ts:167` `REST_ONLY_BY_DESIGN`: `notification/commands/confirm-subscriber` and `notification/commands/unsubscribe`.
  - `src/shared/api/contract/authenticated-surface.spec.ts:46` `PUBLIC_BY_DESIGN`: GET and HEAD for confirm, and GET, HEAD and POST for unsubscribe. The spec keys each element of a method array separately (`:171-186`). Use literal `method` and `url`.
- `src/config/notification-env.ts`, `env.ts`, `.env.example`, `docker-compose.yml` (api :66 and worker :96 beside `BETTER_AUTH_SECRET`), `.github/workflows/ci.yml:43-51` (database job env) -- the secret.
  - Unit specs never import `env.ts`, so CI's unit job needs nothing. `notification-env.spec.ts:11` checks `Value.Check(schema, defaults())`; its `defaults()` must now include a valid secret.
  - The compose job relies on the base Compose default. `docker-compose.backplane.yml` only overrides other keys and needs no change.
  - An existing developer `.env` lacks the secret, so boot fails until it is added. Implementation Notes give the one-line fix.
- Confirm finds the row by `confirmation_token_hash`, which has no index. RLS limits the scan to one organization's rows on a rate-limited route. Accepted for v1; the story adds no migration.
- Test helpers: `signUpWithOrg`, `uniqueRecipient`, `messagesTo`, `capturing`, `captureLogs`. In tests, POST a subscribe and drain `confirmationSendsService` to get a real link from Mailpit.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/notification-env.ts` (+ spec), `env.ts`, `.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml` -- `NOTIFICATION_LINK_SECRET` as the Boundaries say; export `env.notificationLinkSecret`. The spec covers a missing and a short secret.
- [x] `src/modules/notification/domain/unsubscribe-link.ts` (+ `unsubscribe-link.spec.ts`) -- sign, verify, build. The spec covers: a round trip; a wrong secret, org, subscriber or signature length; a non-base64url signature returning false without throwing; and the exact link shape.
- [x] `src/shared/db/sql-debug.ts` (+ `sql-debug.spec.ts`) -- the `req` serializer. The spec covers query stripping, the kept fields, and a caller's `req` still winning.
- [x] `src/shared/events/subscriber.events.ts` -- the two creators.
- [x] `src/modules/notification/database/subscriber.repository.ts` -- `confirm` and `unsubscribe`.
- [x] `src/modules/notification/commands/confirm-subscriber/` and `commands/unsubscribe/` -- `.schema.ts`, `.handler.ts` and `.public.route.ts` each.
- [x] The two contract specs -- entries with reasons.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- extend 6.3's owner entry on 5.4.1's wording: the confirm and unsubscribe links are `no-store`, have no validators and no `OPTIONS`.
- [x] `src/modules/notification/confirm-and-unsubscribe.integration.test.ts` -- every matrix row, using real links: the confirm link from Mailpit after a real subscribe, and the unsubscribe link from `unsubscribeLink` with `env.notificationLinkSecret`. Then: unsubscribing a pending row kills its confirm link, and a resubscribe after an unsubscribe can confirm again (with the throttle stamp moved back in SQL).

**Acceptance Criteria:**
- Given the signature check replaced with one that accepts any signature, when the integration suite runs, then the wrong-signature test fails, and Implementation Notes record it (Constraint 11). Likewise for the `status = 'pending'` and expiry conditions removed from confirm, and for the `req` serializer removed (the log test fails).
- Given `.env` moved aside, when `pnpm run test` runs, then it passes.

## Implementation Notes

- Mutation checks (Constraint 11), each run against `confirm-and-unsubscribe.integration.test.ts` and reverted:
  - Signature check made to accept any signature: `refuses a wrong signature, another organization and a deleted subscriber` fails.
  - `status = 'pending'` and expiry conditions removed from confirm: `refuses an expired token` and `refuses the token of a non-pending row` fail.
  - `req` serializer removed from the logger options: `carry neither a token nor a signature` fails.
- An existing developer `.env` needs one line: `NOTIFICATION_LINK_SECRET=dev_only_link_secret_dev_only_link_secret` (any 32+ characters).

- Review fixes (pass 1, Triage Log rows marked patch):
  - A rate-limit case builds its own app, fills one IP's bucket on the confirm link and on the unsubscribe link, and expects a 429 for the next GET and for a HEAD, with `retry-after`, the public headers and `no-store`. A refused unsubscribe leaves the row unchanged. With `config.rateLimit` removed from the confirm route, it fails (checked, then restored byte for byte).
  - `linkOnSend` sets `cache-control: no-store`, so the 413, the 429 and any 500 carry it too.
  - `sql-debug.spec.ts` passes a caller `req` serializer and asserts it wins.
  - The malformed-subscriber case is signed for that id itself, so only the schema refuses it. The 413 case asserts the row unchanged and no event. The invalid-link HEAD on unsubscribe asserts an empty `text/plain` body.
  - `confirm` filters `org_id = ${tx.orgId}` as well as the hash, like `unsubscribe`.
  - `src/config/notification-link-secret.integration.test.ts` spawns `src/index.ts api` with the secret empty and with 31 characters holding a marker. It expects a non-zero exit naming `NOTIFICATION_LINK_SECRET` and output that never contains the marker.
  - `notification-env.ts`'s header comment now covers the emailed links and says only the secret has no default.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-22). Reviewers: blind-hunter (B), edge-case-hunter (E), verification-gap (V). Two reviewers hit a usage limit and were resumed; the diff was unchanged.

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | B1: the HMAC message has no purpose label, so a later link signed with the same secret over the same ids would also unsubscribe | low | True of `<orgId>\n<subscriberId>`, and cheap to change before 6.7 emails the first link. But the message is fixed in the frozen block, and no second link type is planned in v1 | intent_gap: the owner chose A (add the label), applied as a one-line change |
| 2 | B2: the secret cannot be rotated without breaking every link already sent | low | DOMAIN says changing the secret breaks old links, as decided (D17). Accepting a previous secret is a new rule | defer |
| 3 | B3: Compose falls back to a dev secret printed in the repo, so a deployment that forgets the variable boots with a known key | medium | `docker-compose.yml` gives `${NOTIFICATION_LINK_SECRET:-dev_only…}`, the pattern `BETTER_AUTH_SECRET` already uses. Refusing known dev values in production belongs with deployment hardening | defer |
| 4 | B4/E4/V-other: each route has its own rate-limit bucket, so confirm, unsubscribe GET and unsubscribe POST each allow the page's budget | low | Confirmed in `@fastify/rate-limit` 11.2.0: each route gets `store.child(...)`, a separate LRU, and `groupId` only changes the key inside one store. The page and the stream already have one bucket each; 5.4.1 bounds per route, not per IP across routes | reject |
| 5 | B5/V1: no test reaches a 429 on the link routes | low | Pre-verified gap: deleting `config.rateLimit` passes every test, because each call uses a fresh IP | patch |
| 6 | B6: only the handler's answers carry `no-store`; the 413, 429 and 500 do not | low | `sendLinkText` sets it; `linkOnSend`, which runs on every answer, does not | patch |
| 7 | B7/E1: the "caller req still wins" test never passes a caller `req` | low | `sql-debug.spec.ts` calls `appLoggerOptions({ level })` only; the spec's task claims the case | patch |
| 8 | B8: the malformed-subscriber case passes with `format: 'uuid'` removed | low | It reuses a signature for another id, so `verifyUnsubscribe` refuses it first | patch |
| 9 | B9: the 413 test does not prove nothing changed | low | It checks the status and one header only | patch |
| 10 | B10: the invalid-link HEAD on unsubscribe checks only the status | low | The confirm HEAD test checks the empty body and `text/plain`; this one does not | patch |
| 11 | B11: `confirm` filters by hash without `org_id`, unlike `unsubscribe` | low | RLS already scopes it; adding the filter is a direct correction for consistency | patch |
| 12 | B12: no test proves boot fails without the secret, naming it and quoting nothing | low | Only `Value.Check` runs in the unit spec; the env-schema load is never exercised | patch |
| 13 | B13: `notification-env.ts`'s header comment is stale and overruns the line width | low | It says every variable defaults and is headed "Outgoing email" | patch |
| 14 | E2: a caller-supplied `req` serializer brings the query string back | low | The spec chose "a caller's `req` still wins" to keep `sql-debug.spec.ts:135-144`, and no caller passes one (`buildApp` overrides pass `level` and `stream`) | reject |
| 15 | E3: `format: 'uuid'` accepts uppercase and `urn:uuid:` forms that then fail the signature | low | The emailed link is always the canonical lowercase id, and the altered form gets the uniform answer, never a 500, because the signature check runs before any SQL | reject |

## Verification

**Commands:**
- `pnpm run check` -- passes
- `pnpm run test`, with `.env` present and moved aside -- passes
- `docker compose up -d` (postgres, mailpit and migrate only), then `pnpm run test:integration` -- passes
- `pnpm run test:e2e` -- passes
- `pnpm run auth:schema:check` -- passes
