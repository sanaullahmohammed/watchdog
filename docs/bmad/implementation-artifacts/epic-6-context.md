# Epic 6 Context: Subscriber notifications

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

People find out about changes without watching the page. A visitor subscribes by email and confirms, then is told about every public change: each public incident timeline entry, and each maintenance window being scheduled, started or completed. Anyone can also follow the page as an Atom feed. Covers FR19 (delivery to Mailpit), FR20 (feed) and FR21 (subscribe, confirm, unsubscribe, dispatch).

## Stories

- Story 6.1: Subscriber addresses never reach the logs
- Story 6.2: Send email through SMTP
- Story 6.3: Subscribe to an organization's status page
- Story 6.4: Confirm and unsubscribe through the emailed links
- Story 6.5: One rule for what is public
- Story 6.6: Work out who is owed each public change
- Story 6.7: Send owed emails, with retries
- Story 6.8: Follow a status page as an Atom feed
- Story 6.9: Prune old deliveries and subscribers
- Story 6.10: Prove subscribe to unsubscribe end to end

## Requirements & Constraints

- A subscription covers the whole public page of one organization; there is no per-service scope. An address is unique per organization (trimmed, lowercased) and states are `pending`, `confirmed`, `unsubscribed`.
- Notified: every public incident timeline entry; maintenance scheduled, started, completed. Editing or deleting a window notifies no one. Nothing goes out that the public page itself omits.
- Recipient: confirmed before the change was recorded and still confirmed when the delivery row is created. Unsubscribing stops all pending deliveries.
- Subscriber addresses must never appear in logs, including inside Postgres error messages and nested/`cause`/`AggregateError` errors (story 6.1 comes first for this reason).
- Emails are plain text only. Every email carries `List-Unsubscribe` (and RFC 8058 one-click POST support).
- Subscribe, confirm, unsubscribe and the feed are REST only; no GraphQL form and no admin subscriber list in v1 (exemption recorded in the parity spec and ARCHITECTURE).
- Abuse bounds on subscribe: own IP limit of 5/hour, at most one confirmation email per address per organization per 10 minutes (tracked on the row), identical 202 for new, pending or confirmed addresses, uniform miss for unknown slug, CORS preflight admits `Content-Type`. Public-route bounds (one operation, IP rate limit, cache validators, CORS without credentials) are inherited.
- Tokens: 32 random bytes, stored as SHA-256 hash. Confirmation token valid 24 h; resubscribing a pending address issues a new token (throttled), a confirmed address gets nothing, an unsubscribed one returns to pending. Wrong/expired token gets one uniform plain-text answer. Links act on GET and answer in plain text.
- Unsubscribe link is signed, not stored: subscriber id plus HMAC-SHA256 over org id and subscriber id, keyed by `NOTIFICATION_LINK_SECRET`; changing the secret breaks old links.
- Atom feed at `/status/:orgSlug/feed.atom`: hand-built XML, no new dependency, latest 50 entries newest first, ties by sequence/id, `tag:` entry ids, same public exclusions, ETag/304, rate limit, CORS.
- Retention: final deliveries and unsubscribed subscribers pruned after `NOTIFICATION_RETENTION_DAYS` (default 90); pending subscribers deleted 7 days after token expiry.

## Technical Decisions

- New `notification` module (vertical slice). Modules never import each other; cross-module reads of `organization`, `incident_updates`, `incidents`, `incident_service_impacts`, `maintenance`, `maintenance_services`, `services` go on the foreign-table allowlist before the read.
- Email: `nodemailer` over SMTP; settings `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, plus `PUBLIC_BASE_URL` for links (defaults to `BETTER_AUTH_URL`'s origin) and `NOTIFICATION_LINK_SECRET`. All read via `src/config`; api and worker must still boot, and unit tests pass, with `.env` absent. Sender reports accepted / transient (network, 4xx) / permanent (5xx) and never includes the recipient in diagnostics.
- Delivery derives from durable history, not events. A per-organization cursor in its own table follows `incident_updates.sequence` and maintenance timestamps (`created_at`, `started_at`, `completed_at`), re-reading 5 minutes behind; the ledger's unique key (subscriber, source type, source id) absorbs repeats. A window deleted before send is dropped. Sequence is insert order, not commit order, hence the overlap.
- Ledger statuses `pending`, `sent`, `failed`, `abandoned`. Dispatch claims rows in a short transaction with `for update skip locked` and a lease (bump `next_attempt_at`), sends outside any transaction, then records the outcome in a second one. Marked sent only after SMTP accepts (at-least-once). Retry wait 60 s doubling to a 3600 s cap, max 8 attempts, then `abandoned`; SMTP 5xx is `failed` at once. The pass is a third worker loop beside maintenance and monitors, every 30 s, no NOTIFY wake-up.
- The "what is public" rule moves into `src/shared` so the page, feed and notification pass share one rule.
- Events (admin-only, in-process, not bridged): `subscriber.created`, `subscriber.confirmed`, `subscriber.unsubscribed`, `notification.email_queued`, `notification.email_sent`, `notification.email_failed` (the last three once per delivery, from the worker).
- New tables with `org_id` need RLS enabled, forced, and a policy; tenant access only through `withTenantTransaction`. Genesis docs and applied migrations are not edited.
- Handlers apply their schema via `assertMatchesSchema`/`assertUuid`; routes and handlers follow the existing slice conventions.

## Cross-Story Dependencies

- 6.1 precedes any story that stores an address (6.3 on).
- 6.2 (sender) precedes 6.3 (confirmation email) and 6.7 (dispatch).
- 6.3 precedes 6.4; 6.5 (shared public rule) precedes 6.6 and 6.8 and touches `status-page`.
- 6.6 (ledger and cursor) precedes 6.7; 6.9 prunes what 6.3 to 6.7 create; 6.10 proves the whole flow.
- Tests: integration tests read Mailpit's HTTP API through a helper in `src/shared/testing/`, filtering by a per-test unique recipient (files run concurrently on one Mailpit). The notification pass is always run scoped with `{ orgIds }`, never unscoped. The e2e (Cucumber) suite covers the full flow in 6.10.
