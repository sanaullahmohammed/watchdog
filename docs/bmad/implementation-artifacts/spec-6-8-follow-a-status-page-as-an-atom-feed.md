---
title: 'Story 6.8: Follow a status page as an Atom feed'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'd12ccf13333b396edfcf9bde90d9a4827dbf1f19'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A follower can learn about public changes only by email or by watching the page. FR20 asks for a feed of the incident and maintenance lifecycle that any feed reader can follow anonymously.

**Approach:** `GET /status/:orgSlug/feed.atom`, a REST-only query in the `notification` module. It holds the organization's latest 50 public changes as a hand-built Atom document, and inherits the public page's bounds (ARCHITECTURE 5.4.1, 5.6, 7.1).

## Boundaries & Constraints

**Always:**
- **What is in it.** The same changes the emails are about (story 6.6): each public timeline entry, by `publicTimelineEntry`; and each window's `created_at` (scheduled), `started_at` and `completed_at`, when set. Then `publishable` over each item's services, as the queue command does. No copy of either rule.
- **Order.** Newest first by when each happened, ties by source id, then completed, started, scheduled. At most 50 entries.
- **Reaching 50.** Candidates are read newest first in batches of 100 by a keyset over that order, and `publishable` runs on each batch, until 50 are kept, the history runs out, or 10 batches (1,000 candidates) have been read. **Scan cap (owner, 2026-10-22):** past the cap the feed holds what it found, possibly fewer than 50, so an anonymous request never walks an unbounded history. Positions cross to SQL as text (6.6 Implementation Notes).
- **One snapshot.** The reads run in one `withTenantTransaction` with `{ isolation: 'repeatable read', readOnly: true }`.
- **The document** (RFC 4287): `feed` with `id`, `title` (`<Org name> status`), `updated`, `author/name` (the organization's name), `link rel="alternate"` to `<PUBLIC_BASE_URL>/status/<slug>` and `link rel="self"` to the feed. Each `entry` has `id`, `title`, `updated` (when it happened), the alternate link, and `content type="text"`. Times are RFC 3339 UTC.
- **Ids** are `tag:` URIs that never change for a change: `tag:<PUBLIC_BASE_URL hostname>,<organization createdAt as YYYY-MM-DD UTC>:<orgId>` for the feed, plus `/incident-update/<id>` or `/maintenance/<id>/<scheduled|started|completed>` for an entry. A hostname that is an IPv6 literal, which RFC 4151 does not allow, is replaced by `localhost` (owner, 2026-10-22).
- **`updated`** of the feed is its newest entry's time, or the organization's `createdAt` when it has none, so the body holds no generation time.
- **Escaping.** `& < > "` are escaped in every text and attribute, and attributes are double-quoted. A carriage return is written as `&#13;`, so a CRLF survives parsing (owner, 2026-10-22). Characters XML 1.0 forbids (controls other than tab, LF and CR, lone surrogates, U+FFFE, U+FFFF) are removed.
- **Bounds**, as `/status/:orgSlug` has them: `GET` and `HEAD` in one route and one rate-limit bucket (`env.publicSurface.rateLimit`); `publicHeaders` in `onSend` on every answer, the 404 and 429 included; `Cache-Control: public, max-age=PUBLIC_PAGE_MAX_AGE_SECONDS`; a strong `ETag` over the body, and 304 with no body on a match; an unrationed `OPTIONS` answering 204 and admitting `if-none-match`. `Content-Type: application/atom+xml; charset=utf-8`.
- **Miss.** A malformed or unknown slug throws `NotFoundException(PUBLIC_PAGE_NOT_FOUND)`, checked inside the handler with `isSlug`, never by a params schema.
- REST only: `REST_ONLY_BY_DESIGN` and `PUBLIC_BY_DESIGN` name the slice and its operations.
- **Wording (owner, 2026-10-22): the email's.** An entry's title is the email subject without `[Org] ` (`Database outage: Investigating`, `Maintenance started: Upgrade`); its content is the email body's change lines, without the page and unsubscribe links. One exported `describeChange(source)` in `notification-email.ts` serves both, so they cannot drift.
- **XML in tests (owner, 2026-10-22):** `fast-xml-parser` as an exact-pinned devDependency, imported only by tests, so an independent parser checks the shape and the escaping. The runtime stays dependency-free.

**Never:** a new runtime dependency; a GraphQL form; a second copy of the public rule or of the email wording; `setNotFoundHandler`; editing an applied migration, `docs/genesis/*` or `AGENTS.md`; an unscoped worker pass in a test.

## I/O & Edge-Case Matrix

| Scenario | State | Result |
|---|---|---|
| Happy path | two public entries on an incident; a window created, started, completed | 200, five entries newest first, valid Atom |
| Lifecycle | one window created, started, completed | three entries, each at its own time |
| Never started | a window completed while `scheduled` | two entries; the second titled `Maintenance ended without starting: <title>` |
| Over 50 | 55 public changes | the newest 50 |
| Hidden past a batch | 110 hidden changes newer than 60 visible ones | the newest 50 visible ones |
| Scan cap | 1,000 hidden changes newer than 60 visible ones | no entries; a valid feed |
| Hidden | a draft-era entry; an incident and a window naming only a hidden or archived service; a deleted window | absent |
| Escaping | a title `<b>&"'` with U+0001 | parses; the text round-trips without U+0001 |
| Empty | an organization with no changes | valid feed, no entries, `updated` = `createdAt` |
| Revalidate | same `If-None-Match` | 304, no body; after a new change, 200 and a new `ETag` |
| HEAD | `HEAD` | `content-length` of the GET, no body |
| Cross-origin | `Origin: https://elsewhere.example`, and the preflight | `*`, no credentials; preflight 204 |
| Rate limit | over `PUBLIC_RATE_LIMIT_MAX` | 429 with the public headers |
| Miss | unknown slug, malformed slug, `POST …/feed.atom` | the page's uniform 404 |
| Tenancy | another organization's changes | absent |

</frozen-after-approval>

## Code Map

- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts:30-117` -- the pattern to copy: GET+HEAD, `config.rateLimit`, `onSend` (public headers, 304 without length, HEAD length), ETag and 304, OPTIONS. Its `/status/*` catch-all already answers other methods on the feed path.
- `src/shared/api/public-surface.ts` `publicHeaders`; `src/shared/domain/public-page-miss.ts` `PUBLIC_PAGE_NOT_FOUND`; `src/shared/domain/slug.ts` `isSlug`; `env.publicSurface` (`src/config/env.ts:145`); `env.publicBaseUrl`.
- `src/shared/db/public-page-sql.ts` `publicTimelineEntry`, `visibleService`; `src/shared/domain/public-page.ts` `publishable`. `public-rule-copies.spec.ts` fails on a copy.
- `src/modules/notification/commands/queue-email-notifications/queue-email-notifications.handler.ts:43-82` -- how 6.6 applies the rule to both kinds of change.
- `src/modules/notification/database/public-history.repository.ts` -- `incidentServices`, `maintenanceServices` reuse as is; the scans are cursor-shaped and ascending, so add a new read. `sourceContent` shows the content columns.
- `src/modules/notification/database/organization-by-slug.repository.ts` `findBySlug` -- add `"createdAt"`. `SubscribableOrganization` is also `findById`'s type: select it in both reads.
- `incident_updates_org_created_at_idx (org_id, created_at)` exists (6.6's migration), so the incident keyset needs no new migration. `maintenance` has no timestamp index; its rows are few.
- `POST /api/v1/maintenance/:id/complete` (`maintenance/commands/complete-maintenance`) completes a started window; `transitionDueMaintenance` starts one.
- `src/modules/notification/domain/notification-email.ts` -- `NotificationSource`, `formatUtc`, the wording.
- `src/modules/notification/commands/create-subscriber/create-subscriber.handler.ts:51-53` -- the slug miss in this module.
- `src/modules/status-page/queries/get-public-status-page/get-public-status-page.{handler,schema}.ts` -- query creator, handler and unconstrained params schema shape; `notificationActionCreator` in `src/modules/notification/index.ts`.
- `src/shared/api/contract/api-surface-parity.spec.ts:167` `REST_ONLY_BY_DESIGN`; `authenticated-surface.spec.ts:46` `PUBLIC_BY_DESIGN`.
- `src/shared/db/foreign-table-allowlist.spec.ts:65` -- already lists every table the feed reads.
- `src/modules/status-page/public-surface-bounds.integration.test.ts` -- how 304, CORS, HEAD, 429 and the miss are asserted. `src/shared/testing/fixtures.ts` -- `declareIncident`, `transitionIncident`, `insertIncidentUpdate` (`createdAtOffset`), `insertDraftIncident`, `scheduleMaintenance`, `transitionDueMaintenance`, `createService`, `updateService`, `archiveService`.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-lock.yaml` -- `fast-xml-parser` devDependency, then `pnpm install --lockfile-only`.
- [x] `src/modules/notification/domain/notification-email.ts` + spec -- export `describeChange(source): { title, lines }`; the email builds from it, its output unchanged (the existing spec still passes).
- [x] `database/organization-by-slug.repository.ts` -- `createdAt` on `findBySlug`.
- [x] `database/public-history.repository.ts` -- `latestChanges(tx, before, limit)`: public entries joined to `incidents`, and window changes, with their content and position, newest first by the Order rule.
- [x] `queries/get-atom-feed/get-atom-feed.{schema,handler}.ts` -- `getAtomFeedQuery({ slug })`: miss, snapshot, batches, `publishable`; returns organization and entries, no DTO.
- [x] `dtos/atom-feed.ts` + spec -- `toAtomFeed(view, publicBaseUrl)`, `escapeXml`, `atomFeedETag(body)`; the spec covers escaping, removed characters, ids and the empty feed.
- [x] `queries/get-atom-feed/get-atom-feed.public.route.ts` -- route and OPTIONS.
- [x] `api-surface-parity.spec.ts`, `authenticated-surface.spec.ts` -- the slice and `GET`, `HEAD`, `OPTIONS /status/:orgSlug/feed.atom`.
- [x] `src/modules/notification/atom-feed.integration.test.ts` -- every Matrix row, with a header comment mapping each sabotage to its test by name. Seed incident entries with spaced `createdAtOffset`, and assert window order against the timestamps read back, never the seeding order (the WSL clock steps back). The 429 test builds its own app, while the file's app is still open, as `public-surface-bounds.integration.test.ts:449` does.

**Acceptance Criteria:**
- Each Matrix row is an AC: given its State, when the feed is requested, then its Result.
- Given a feed, when it is parsed, then it starts with the XML declaration, its root is `feed` in the Atom namespace, the `Content-Type` is `application/atom+xml; charset=utf-8`, every required element is present, and the entries match the seeded changes in order.
- Sabotage, recorded in Implementation Notes, makes a test fail: one batch only; no cap; no `escapeXml`; no `publicTimelineEntry` filter; no `publishable`.

## Design Notes

```
handler: isSlug ∧ findBySlug, else 404
  tx (repeatable read, read only):
    before = null; kept = []
    loop ≤ 10: batch = latestChanges(tx, before, 100)
          kept += publishable(batch + services)  until 50 or batch < 100
          before = last of batch
route: toAtomFeed → ETag → 304 | 200
```

`latestChanges` is `union all` of the two sources, each with its own keyset predicate and `limit`, then ordered and limited again. Sort key `(at desc, source_id desc, rank desc)`, rank completed 3, started 2, scheduled 1, incident update 0; the keyset is the same row comparison, `(at, source_id, rank) < (before)`, ids compared as `uuid`. `publicTimelineEntry` is in the `where`, so non-public entries never fill a batch. Null window timestamps are excluded.

The document opens `<?xml version="1.0" encoding="utf-8"?>` and its root is `<feed xmlns="http://www.w3.org/2005/Atom">`.

Accepted: order is by time, so on a machine whose clock steps back two entries of one incident can list against their `sequence`. Content is read from current rows, so an edited title or description changes an old entry's text, and the `ETag`, but not its `updated`; deleting the newest window moves the feed's `updated` back.

The tag date is the organization's creation date, so ids stay valid tag URIs and stable for its life. Changing `PUBLIC_BASE_URL`'s host changes every id; readers will see the feed as new. Accepted.

## Verification

**Commands:**
- `pnpm run check`; `pnpm run test` with `.env` and with it moved aside -- pass.
- `pnpm run test:integration` (postgres, mailpit, migrate only), `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass.

## Implementation Notes

Sabotage, each run against `atom-feed.integration.test.ts` and each failed it: one batch only (`FEED_MAX_BATCHES = 1`) -> "reaches past a batch of hidden changes"; no cap (1000 batches) -> "stops at the scan cap"; `escapeXml` returning its input -> "escapes markup and drops a forbidden character"; `AND true` in place of `publicTimelineEntry` -> "leaves out what the page leaves out"; dropping `isolation: 'repeatable read'` from the handler -> "reads every batch from one snapshot"; `publishable` replaced by a pass-through -> the same test, plus the batch and cap tests.

**Verification (main session, 2026-10-22).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (541 modules).
- `pnpm run test`: 466/466 with `.env`, and again with it moved aside.
- `pnpm run test:integration` (postgres and mailpit only): first full run 832/833. The failure was 6.7's "words each incident entry with its own status, message and posted time" (0 emails, 2 expected), which this story does not touch. Alone, that file then failed once in eight runs and passed seven; the full suite then passed 833/833 twice. `journalctl` showed 76 "Time jumped backwards" in the 40 minutes before: the WSL clock flake 6.7's notes describe (a row due at the queue's `now()` looks not yet due after a step back). The implementing sub-agent's first full run failed once too, in "puts an emailed unsubscribe link to work by GET and by one-click POST" (`confirm-and-unsubscribe.integration.test.ts`), which passed when rerun alone twice and in its next full run.
- `pnpm run test:e2e`: 86 steps pass. `pnpm run auth:schema:check`: in sync.

**Verification (main session, 2026-10-22, after the review pass 1 patches 13 to 20).**
- `pnpm run check` passes: 11 Biome warnings, none in files this story touches; no dependency violations (541 modules).
- `pnpm run test`: 466/466 with `.env`, and again with it moved aside.
- `pnpm run test:integration` (postgres and mailpit only; the sub-agent found the stack down and restarted postgres, mailpit and migrate): 836/836.
- `pnpm run test:e2e`: 86 steps pass. `pnpm run auth:schema:check`: in sync.

## Spec Change Log

## Review Triage Log

Spec review, before approval (one reviewer, same model as the session).

1. high, owner decided -- "Reaching 50" had no bound on the anonymous surface. Scan cap of 10 batches added to the frozen block, with a Matrix row.
2. medium, partly false -- "each batch is a full scan": `incident_updates (org_id, created_at)` exists since 6.6's migration (the reviewer read only the dropped timeline index). The `union all` shape and `publicTimelineEntry` in `where` were added to Design Notes.
3. medium, fixed -- keyset direction and rank pinned in Design Notes.
4. medium, fixed -- clock-dependent order: test seeding rule added to the test task; same-incident inversion recorded as accepted.
5. medium, fixed -- XML declaration and Atom namespace in Design Notes and an AC.
6. low, owner decided -- CR written as `&#13;`; attributes double-quoted.
7. low, owner decided -- IPv6-literal host falls back to `localhost`.
8. low, fixed -- the complete route named in the Code Map; owner added the "Never started" Matrix row.
9. low, fixed -- the 429 test builds its own app.
10. low, fixed -- `createdAt` in both organization reads.
11. low, fixed -- content edits and a moving feed `updated` recorded as accepted.
12. low, fixed -- every Matrix row is an AC.

Pass 1 (blind hunter, edge case hunter, verification gap; same model as the session). No intent gap or bad spec.

13. medium, patch -- no test reads past a first batch with windows in the history, so `olderWindow` and a batch boundary on a window row are unexercised (verification gap; confirmed: both multi-batch tests seed incident updates only).
14. low, patch -- `expectedOrder`'s comparator never returns 0 for equal ids, so its rank tiebreak is unreachable; it also sorts on JS milliseconds while SQL orders on microseconds (verification gap; edge case hunter). Direct correction in the oracle.
15. medium, patch -- nothing backs the handler's one-snapshot claim with a write committed between batches, which AGENTS.md asks for (blind hunter).
16. low, patch -- the batch and cap tests hard-code 110 and 1000 rather than deriving them from `FEED_BATCH`, `FEED_MAX_BATCHES`, `FEED_ENTRIES` (blind hunter).
17. low, patch -- no test of HEAD with a matching `If-None-Match`, the path that needs both `onSend` branches (blind hunter).
18. low, patch -- `atom-feed.spec.ts` casts its entry fixture `as unknown as AtomFeedView`, hiding type drift (blind hunter).
19. low, patch -- two test names lost their apostrophes (blind hunter).
20. low, patch -- `feedId`'s comment says the id never changes for the organization's life; it changes with `PUBLIC_BASE_URL`'s host (blind hunter). Design Notes accept that; the comment must say it.
21. low, reject -- incident entries order by `created_at`, not `sequence` (blind hunter). Accepted in Design Notes before approval.
22. low, owner -- the scan cap can serve fewer than 50 entries, where ARCHITECTURE 5.6 says "the latest 50" (blind hunter). Owner's decision (frozen); the genesis wording is raised with the owner, not edited here.
23. false -- "no index supports the feed query" (blind hunter). `incident_updates_org_created_at_idx (org_id, created_at)` exists since 20261022120000; the reviewer read only the dropped timeline index.
24. low, defer -- `If-None-Match` is compared exactly: a list, `*`, or a proxy-weakened `W/` tag never gets a 304, and there is no `Last-Modified` (blind hunter; edge case hunter). The page has the same comparison; pre-existing on the shared public surface.
25. low, reject -- an edited title or schedule changes an entry's text but not its `updated` (blind hunter; edge case hunter). Accepted in Design Notes.
26. false -- "the CR sabotage goes uncaught because the parser does not normalise line ends" (blind hunter). Checked: fast-xml-parser turns a raw `\r\n` into `\n`, so without `&#13;` the `\r\n` assertion fails. `XMLValidator` accepts `&nbsp;`, so adding it would not tighten anything.
27. low, reject -- the page does not advertise the feed (no field or `Link` header) (blind hunter). No requirement asks for it; v1 serves no HTML.
28. low, reject -- entries carry no service categories, `published` or per-incident link (blind hunter). The owner chose the email wording; no requirement asks for more.
29. low, reject -- a preflight on an unknown slug, and whether the feed shares the page's bucket, are untested (blind hunter). The preflight touches no data by design; separate per-route buckets are how 5.4.1's opt-in works.
30. low, reject -- shared-IP aggregators may hit the per-IP limit (blind hunter). The frozen bounds say the page's limit; the same holds for the page.
31. low, reject -- a `PUBLIC_BASE_URL` host with a trailing dot gives an empty DNS label in the tag (edge case hunter). Unlikely configuration; the fix is a new guard.
