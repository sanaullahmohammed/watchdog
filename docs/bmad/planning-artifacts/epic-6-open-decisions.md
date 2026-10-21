# Epic 6 — owner decisions

**Decided 2026-10-21 (owner): every recommendation below was accepted as written ("accept all").** D17 was added and decided the same day, while the stories were reviewed. These decisions are recorded in DOMAIN (Subscriber, NotificationDelivery, NotificationCursor) and ARCHITECTURE (the module table, 5.6, 7.1). Those documents own the decisions, and this file is the record of how they were reached.

## What genesis already settles

The story writer does not need to ask about any of these.

- **Subscriber model** (`DOMAIN.md:420-451`):
  - Fields: email (trimmed and lowercased), status (`pending`, `confirmed` or `unsubscribed`), the hash of each token, and `confirmed_at`.
  - Each address is unique per organization, so the same address can subscribe to several organizations.
- **NotificationDelivery ledger** (`DOMAIN.md:453-486`):
  - The four source types: `incident_update`, `maintenance_scheduled`, `maintenance_started`, `maintenance_completed`.
  - Statuses: `pending`, `sent`, `failed`, `abandoned`.
  - Unique on (subscriber, source type, source id).
  - Final deliveries, and unsubscribed subscribers, are pruned after `NOTIFICATION_RETENTION_DAYS` (default 90).
- **What notifies:**
  - Every public incident timeline entry.
  - A maintenance window being scheduled, started or completed.
  - Editing or deleting a window notifies no one.
- **Who is told:** a subscriber who was confirmed before the change was recorded and is still confirmed when the delivery row is created.
  - The public-page rule applies, so nothing goes out that the page itself omits.
  - Unsubscribing stops every pending delivery.
- **How delivery runs** (`ARCHITECTURE.md:492-502`):
  - A per-organization worker pass derives deliveries from durable history, using a cursor that re-reads an overlap. Events are not the trigger.
  - Delivery is at-least-once, and a row is marked sent only after the SMTP server accepts it.
  - Rows are claimed with `for update skip locked`.
  - A transient failure is retried with exponential backoff, from about 1 minute up to about 1 hour, until a configured maximum. Then it is marked `abandoned`. An SMTP 5xx is marked `failed` at once.
  - Every email carries `List-Unsubscribe`.
  - Confirm and unsubscribe links answer in plain text.
  - Subscriber addresses never reach the logs.
- **The subscribe route** inherits section 5.4.1's four bounds, plus a throttle on confirmation emails per address.
- **Events** (`DOMAIN.md:1424-1433`): `subscriber.created`, `subscriber.confirmed`, `subscriber.unsubscribed`, `notification.email_queued`, `notification.email_sent` and `notification.email_failed`. All are admin-only and not bridged.
- **Requirements:**

| Requirement | Says | Verified by |
|---|---|---|
| FR19 | Mailpit delivery | integration tests |
| FR20 | a feed for incident and maintenance lifecycle events | XML shape and ordering tests |
| FR21 | subscribe, confirm, unsubscribe, dispatch | E2E |

## What exists today

- There is no `notification` module and no migration for subscribers or deliveries.
- There is no SMTP dependency, and `src/config` has no SMTP settings.
- Compose already starts `mailpit`, and it already gives `api` and `worker` `SMTP_HOST` and `SMTP_PORT` (`docker-compose.yml:68-69`, `:95-96`).
- Story 9.13 is done.
- Two `deferred-work.md` entries are marked "Epic 6 prerequisite" (`:87-93`):
  - values inside Postgres errors, such as a duplicate key's `Key (email)=(...)`, still reach the logs;
  - errors that are nested, or wrapped in an `AggregateError` or a `cause`, escape redaction.
- `deferred-work.md:151-153`: `sequence` follows insert order, not commit order, so a cursor over it still needs the overlap.

## Decisions

| # | Question | Decided (owner, 2026-10-21) | Alternatives considered |
|---|---|---|---|
| D1 | Should the log-scrub prerequisite be the first story? | **Yes, as story 6.1.** It scrubs recursively in the `err`/`error` serializers and redacts Postgres error fields, before any address is stored. | Fold it into the subscribe story (breaks constraints 1 and 2); defer it (contradicts the recorded target). |
| D2 | What does a subscription cover? | **The whole public page of one organization.** That matches DOMAIN, which has no scope field. | Per service or per group: needs new columns, and a DOMAIN change first. |
| D3 | Which feed format? | **Atom only**, at `/status/:orgSlug/feed.atom`, hand-built XML, no new dependency. It holds the latest 50 entries, newest first, ties settled by sequence or id, with `tag:` entry ids. It applies the same public-page exclusions and inherits the 5.4.1 bounds (ETag/304, rate limit, CORS). | RSS 2.0 only; or both, which doubles the work and the tests. |
| D4 | Does GraphQL get the subscribe surface? | **No: REST only** for subscribe, confirm, unsubscribe and the feed, with an exemption recorded in ARCHITECTURE 7.1 and `api-surface-parity.spec.ts`. No admin subscriber list, because no FR asks for one (constraint 5). | A public GraphQL `subscribe` mutation, which adds an anonymous mutation surface; an admin list of subscribers. |
| D5 | How is email sent? | **`nodemailer`** over SMTP, with new settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optional auth and TLS. Emails are **plain text only**. Links use a new `PUBLIC_BASE_URL`. | A hand-rolled SMTP client; reusing `BETTER_AUTH_URL` for links. |
| D6 | What do the confirm and unsubscribe links do? | **A GET acts at once and answers in plain text.** Unsubscribe also accepts a one-click POST (RFC 8058 `List-Unsubscribe-Post`). The risk that a mail scanner opens a link is accepted for v1. A wrong or expired token gets one uniform plain-text answer. | The GET shows a page that asks for a POST, which needs HTML, a v1 non-goal. |
| D7 | How is the subscribe form protected from abuse? | **`POST /status/:orgSlug/subscribers` with `{ email }`.** It has its own IP limit (5 per hour) and sends at most 1 confirmation email per address per organization every 10 minutes, tracked on the row. It gives the same 202 answer for a new, pending or confirmed address, so it cannot be used to test addresses. An unknown slug gets the page's uniform miss, and the preflight admits `Content-Type`. | Reuse the page's rate limit (looser); keep the throttle in memory (lost on restart, and not shared between processes). |
| D8 | What are the token rules? | **The confirmation token lasts 24 hours. The unsubscribe token is permanent.** Each is 32 random bytes, stored as a SHA-256 hash. Subscribing again works like this: a pending address gets a new token (throttled); a confirmed address is sent nothing (same answer); an unsubscribed address goes back to pending, with a new confirmation. | A 72-hour lifetime; a token that never expires. |
| D9 | What are the retry numbers and pass timing? | **Wait 60 s, then double, capped at 3,600 s, for at most 8 attempts** (waits of 1, 2, 4, 8, 16, 32 and 60 minutes, about 2 hours, then `abandoned`). The pass runs every 30 s. No NOTIFY wake-up in v1. | 10 attempts; give up after a fixed 24 hours. |
| D10 | Is a pending address that never confirms ever removed? | **Yes: deleted 7 days after its token expires**, in the retention step, so the anonymous form cannot fill the table. | Keep it until the 90-day prune; keep it forever. |
| D11 | How is the cursor built? | **Per organization, in a table of its own.** It follows `incident_updates.sequence` for incident entries and a timestamp for maintenance (`created_at`, `started_at`, `completed_at`). Each pass re-reads 5 minutes behind the cursor, and the ledger's unique key absorbs the repeats. A window deleted before its email is sent is dropped. | Timestamps only; no cursor, joining history against the ledger instead, which gets slower as history grows. |
| D12 | Is the lock held while sending? | **No.** Claim a row in a short transaction with a lease (bump `next_attempt_at`), send outside it, then record the outcome in a second transaction. A slow SMTP server never holds a database connection. | Hold the `skip locked` row lock across the send (simpler, but it pins a pool connection). |
| D13 | Where does the "what is public" rule live? | **Move it into `src/shared`**, so the status page, the feed and the notification pass all apply one rule. The notification module's reads of `incident_updates` and `maintenance` are added to the foreign-read allowlist. | Each module keeps its own copy (they can drift). |
| D14 | Which events are emitted? | **As DOMAIN's catalog lists them:** `subscriber.*` from the commands, and `notification.email_*` once per delivery from the worker. They are admin-only, in-process and not bridged, so they cause no storm. | Drop `email_queued` (needs a DOMAIN change first). |
| D15 | How are email and the end-to-end flow tested? | **Integration tests read Mailpit's HTTP API** (`:8025`) and filter by a unique recipient per test. **E2E (Cucumber)** covers subscribe, the email, confirm, a posted update, the notification email, and unsubscribe. The notification pass always runs scoped with `{ orgIds }`. | A stubbed transport, which would not satisfy FR19's "delivered to Mailpit". |
| D16 | What order do the stories go in? | **The draft order below.** Each story has one migration or one command/query pair (constraint 2). The feed needs only reads, so it can run in parallel. | The story writer refines it. |
| D17 | How does the unsubscribe link work? It was added while the stories were reviewed: DOMAIN stored only a hash of the unsubscribe token, which the worker could not turn back into a link. | **A signed link.** It carries the subscriber id and an HMAC-SHA256 over the org id and subscriber id, keyed by a new `NOTIFICATION_LINK_SECRET`. Nothing usable is stored. Changing the secret breaks old links. | Store the token as-is (simplest, but a leaked database lets someone unsubscribe people); store it encrypted (more code, and still a key to manage). |

Draft story order (D16):

| Story | Content |
|---|---|
| 6.1 | Log scrub (prerequisite) |
| 6.2 | `subscribers` table and the subscribe command |
| 6.3 | Confirm and unsubscribe |
| 6.4 | SMTP sender and its configuration |
| 6.5 | Delivery ledger, cursor, and the pass that writes the ledger |
| 6.6 | Dispatch and retry |
| 6.7 | Atom feed |
| 6.8 | Retention pruning |
| 6.9 | End-to-end proof through Mailpit |

## How to record them

Done 2026-10-21. As with Epic 4, each decision is recorded in the document that owns it:
- DOMAIN for the model, the tokens and retention;
- ARCHITECTURE 5.6 and 7.1 for delivery, the cursor and the REST-only exemption;
- `src/config` for the settings, when the stories land.

The owner approved the genesis edits on 2026-10-21.
