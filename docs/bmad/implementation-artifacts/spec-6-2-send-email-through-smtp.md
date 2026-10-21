---
title: 'Story 6.2: Send email through SMTP'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: 'd3e7ad51abce1102ea2b77ab1fe6db97dab691a8'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing in WatchDog can send email. Story 6.3 (the confirmation email) and story 6.7 (notifications) both need one sender, configured from `src/config`, that reaches Mailpit locally and says plainly whether a message was accepted, should be retried, or failed for good (FR19, ARCHITECTURE 5.6).

**Approach:** Add the `notification` module with an `EmailSender` port and a `nodemailer` SMTP adapter. Register it in the DI container as `emailSender`. Add the SMTP settings and `PUBLIC_BASE_URL` to `src/config` with defaults, so nothing has to be set. Add a Mailpit reader to `src/shared/testing/`, and give CI's database job a Mailpit service.

## Boundaries & Constraints

**Always:**
- Settings: `SMTP_HOST` (default `localhost`), `SMTP_PORT` (default `1025`, 1–65535), `SMTP_FROM` (default `WatchDog <watchdog@localhost>`), `SMTP_SECURE` (default `false`), optional `SMTP_USER` and `SMTP_PASSWORD`, and optional `PUBLIC_BASE_URL`, read only through `src/config`. Boot fails, naming the variables, when only one of `SMTP_USER` and `SMTP_PASSWORD` is set, or when `PUBLIC_BASE_URL` is not a bare http(s) origin. Unset, `PUBLIC_BASE_URL` is `BETTER_AUTH_URL`'s origin. An empty string counts as unset for `SMTP_USER`, `SMTP_PASSWORD` and `PUBLIC_BASE_URL`.
- Messages are plain text only: `to`, `subject`, `text`, and optional extra `headers` (6.3 and 6.7 add `List-Unsubscribe`). There is never an HTML part.
- `send` never throws. It returns `accepted`, `transient` or `permanent`. `permanent` holds exactly when `err.responseCode` is 500–599 and `err.command` is `RCPT TO` or `DATA`: the reply concerns this recipient or message. Everything else is `transient`: a network error, a timeout, a 4xx, an error without an SMTP code, and a 5xx at login or `MAIL FROM`. A 5xx that early means WatchDog's own settings are wrong, and it would recur for every email (owner decision 2026-10-21; ARCHITECTURE 5.6 amended first).
- The `diagnostic` is `SMTP <responseCode>` when there is a reply code. Otherwise it is `err.code`, when that matches `/^[A-Z][A-Z0-9_]{1,31}$/`. Otherwise it is `EUNKNOWN`. It becomes 6.7's `last_error`, which ARCHITECTURE 5.6 says never holds the address. It never includes the error's `name`, `message` or `response`, or the `rejected` list, because those can quote the recipient. The sender logs nothing, and nodemailer's own logger stays off.
- Fixed timeouts: 10 s for DNS, 10 s to connect, 10 s for the greeting, 15 s of socket inactivity, and 45 s for the whole send. A send that hits the 45 s limit reports `transient` with `EDEADLINE`. nodemailer cannot abort a send, so the abandoned one may still be delivered later. Its late result is caught, never left unhandled, and the overall timer is cleared once the send settles, so nothing holds the process open. Delivery is at-least-once, so that duplicate is accepted (ARCHITECTURE 5.6). nodemailer's defaults (2 min to connect, 10 min of inactivity) could stall a worker pass, and nodemailer itself has no overall limit. Story 6.7 needs one shorter than its 60 s retry lease. The adapter accepts overrides, so tests can use short ones.

**Never:**
- No subscriber table, link signing or `NOTIFICATION_LINK_SECRET`. Those belong to 6.3 and 6.4.
- No route, no GraphQL and no event. No transport pooling.
- Tests never stub the transport to prove Mailpit delivery (decision D15).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delivered | Mailpit up, plain-text message | `{ outcome: 'accepted' }`. Mailpit holds one message for that recipient: `From` is `SMTP_FROM`, the text matches, the extra header is present, and there is no HTML part | N/A |
| Refused, temporary | The server answers 450 to RCPT | `{ outcome: 'transient', diagnostic: 'SMTP 450' }` | No recipient in the diagnostic |
| Refused, permanent | The server answers 550 to RCPT | `{ outcome: 'permanent', diagnostic: 'SMTP 550' }` | No recipient in the diagnostic |
| Refused, our settings | The server answers 535 to AUTH, or 550 to MAIL FROM | `{ outcome: 'transient', diagnostic: 'SMTP 535' }` (or `'SMTP 550'`) | No recipient in the diagnostic |
| Bad greeting | The server greets with 554 | `transient`, `SMTP 554` (command `CONN`) | No recipient in the diagnostic |
| Unreachable | Connection refused, or no greeting before the timeout | `transient`, with `ESOCKET` or `ETIMEDOUT` as the diagnostic | Never throws |
| Too slow overall | The server accepts the connection, then answers each command just inside the inactivity timeout | `transient`, `EDEADLINE`, once the overall limit has passed | Never throws |

</frozen-after-approval>

## Code Map

- `src/config/env.ts` -- composes `*EnvProperties` from sibling files and exports grouped config objects. `realtime-env.ts` and its spec show the pattern: properties in their own file, so a spec can read defaults without `.env`.
- `src/config/worker-intervals.ts` -- an example of a boot-time assertion that names the variable.
- `src/server/di/index.ts` -- the awilix container. Its `loadModules` globs (`*.repository|mapper|service|domain|handler`) would not pick up `smtp-email-sender.ts`, so register it there explicitly beside `makeDependencies`.
- `src/modules/service/index.ts:10-20` -- how a module declares its `Dependencies` globally.
- Tests override a DI entry by resolving it and patching it (`check-result-partitions.integration.test.ts:391`).
- `.dependency-cruiser.js` -- `infrastructure/` is the infra layer. Domain may import `*.port.ts` only. `nodemailer` must be in `dependencies` (`not-to-dev-dep`). Production code may not import `src/shared/testing/`.
- `docker-compose.yml:30-38` -- Mailpit publishes 1025 and 8025. api (`:61-69`) and worker (`:88-96`) already set `SMTP_HOST: mailpit` and `SMTP_PORT`.
- `.github/workflows/ci.yml:43-66` -- the database job's `services:` has only postgres. Its env sets nothing SMTP-related, which proves the defaults boot.
- Integration helpers import `env` from `@/config`. Unit specs must not, because CI's unit job has no `.env`.
- `nodemailer@10.0.16` (2026-10-07) has no dependencies. It ships CJS and ESM builds with their own types (`dist/cjs/nodemailer.d.ts`), so use `import { createTransport } from 'nodemailer'`. Pin it exactly, as most dependencies are. Facts read from its source (`dist/cjs/smtp-connection/index.js`):
  - `createTransport` does not connect. Each `sendMail` opens its own connection, so a missing server cannot stop api or worker from booting.
  - The logger is off unless `logger` is set (`shared/index.js:372`).
  - The timeout options are `dnsTimeout`, `connectionTimeout`, `greetingTimeout` and `socketTimeout`. Their defaults are at `:49-52`, and they are used at `:214`, `:352`, `:754`, `:749` and `:1027`. There is no abort signal.
  - `_formatError` (`:861-883`) appends the server's reply to `err.message`, and sets `err.response`, `err.responseCode` and `err.command`, the phase, such as `RCPT TO` or `AUTH PLAIN`. A RCPT refusal (`:1660-1693`) also sets `err.rejected` and `err.rejectedErrors[].recipient`. All of these except `responseCode`, `code` and `command` can carry the address.
  - A refused connection is reported with `code: 'ESOCKET'` (`:184-188`), not `ECONNREFUSED`. A missed greeting is `ETIMEDOUT` (`:754`). A 5xx greeting is `EPROTOCOL` with command `CONN` (`:1314`).
  - The phase is in `err.command`: `RCPT TO` (`:1671`, and `:1690` when every recipient is refused, carrying the 4xx reply if any), `DATA` (`:1717`, `:1741`, `:1761`), `AUTH <method>` (`:523`, `:1613`), and `MAIL FROM` (`:1637`).
  - A text-only message is one `text/plain` part.
  - Local refusals carry command `API` and no reply code, such as "Invalid recipient" (`:1114-1126`). They count as transient. 6.3 validates addresses before storing them, so the cost is bounded: about 2 hours of retries for an address that should never get that far.
- Mailpit API v1: `GET /api/v1/search?query=to:"<addr>"` returns `messages[].ID`. `GET /api/v1/message/{ID}` returns `From {Name, Address}`, `To`, `Subject`, `Text` and `HTML`. `GET /api/v1/message/{ID}/headers` returns the headers. The helper reads them right after `send` resolves, because Mailpit stores a message before it answers 250. If that proves wrong, the helper waits for the message, up to 2 s.
- `.github/workflows/ci.yml:117` -- `test:e2e` runs in the same database job, after the integration suites.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-lock.yaml` -- add `nodemailer` `10.0.16` to `dependencies`, then `pnpm install --lockfile-only`.
- [x] `src/config/notification-env.ts` (+ `.spec.ts`) -- the properties, plus a pure `resolveEmailSettings(raw)` that applies the both-or-neither rule and derives the origin. The spec covers the defaults, the derived origin, a refused path and a refused half-set login.
- [x] `src/config/env.ts` -- compose them and export `email: { host, port, secure, auth?, from }` and `publicBaseUrl`.
- [x] `src/modules/notification/domain/email-sender.port.ts` -- `EmailMessage`, `SendResult` and `EmailSender`.
- [x] `src/modules/notification/infrastructure/smtp-email-sender.ts` -- `createSmtpEmailSender(settings, timeouts?)`. It takes its settings as arguments and imports no config. It returns a plain `{ send }` object, so a test can replace `send` on the resolved singleton. Story 6.7's stub sender for failures does exactly that.
- [x] `src/modules/notification/index.ts` -- declare `emailSender: EmailSender` on `Dependencies`.
- [x] `src/server/di/index.ts` -- register `emailSender` as a singleton built from `env.email`.
- [x] `src/shared/testing/smtp-stub.ts` -- a minimal local SMTP server for unit specs. It can reply with a configured code to AUTH, MAIL FROM or RCPT, never send a greeting, or answer slowly.
- [x] `src/modules/notification/infrastructure/smtp-email-sender.spec.ts` -- drives the real adapter against the stub for every matrix row except "Delivered". Asserts the recipient appears in no diagnostic.
- [x] `src/shared/testing/mailpit.ts` -- `uniqueRecipient()` and `messagesTo(address)` over Mailpit's HTTP API (`http://${env.email.host}:8025`), returning `From`, `To`, `Subject`, `Text`, `HTML` and the headers. Assertions compare `Text` trimmed, because Mailpit keeps the trailing newline.
- [x] `src/modules/notification/smtp-email-sender.integration.test.ts` -- the "Delivered" row, through `app.diContainer.resolve('emailSender')` of a built app.
- [x] `.env.example`, `docker-compose.yml` -- in `.env.example`, a commented block with each variable and its default. In Compose, give `api` and `worker` `SMTP_FROM` and `PUBLIC_BASE_URL: http://localhost:3000`.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- one entry targeting 6.7: the 45 s overall limit must stay below `NOTIFICATION_RETRY_BASE_SECONDS`, which is configurable, so 6.7 checks it at boot. It also covers the late delivery after `EDEADLINE`.
- [x] `.github/workflows/ci.yml` -- add a `mailpit` service to the database job: `axllent/mailpit:latest`, as in Compose, on ports 1025 and 8025, with a `wget --spider` health check against `http://127.0.0.1:8025`. It uses `127.0.0.1` rather than `localhost`, as AGENTS.md advises.

**Acceptance Criteria:**
- Given `.env` moved aside, when `pnpm run test` runs, then it passes. And given CI's database env, which sets no SMTP variable, when the integration suites spawn api and worker, then both boot.
- Given each rule in the classifier and the diagnostic is reverted in turn (a 5xx at RCPT treated as transient, a 4xx as permanent, a 5xx at AUTH or MAIL FROM as permanent, `message` used as the diagnostic, the overall limit removed, an empty `SMTP_USER` treated as set), when the spec runs, then a test fails each time, and Implementation Notes record it (Constraint 11).

## Implementation Notes

- Mutation check (Constraint 11), each rule reverted in turn and `node --test` run over `smtp-email-sender.spec.ts` and `notification-env.spec.ts`, then restored:
  - A 5xx at RCPT treated as transient (`DATA` only): 2 tests fail, the stub's 550-to-RCPT row and the classifier table.
  - A 4xx treated as permanent (`reply >= 400`): 3 fail, the 450-to-RCPT row, the 451-after-DATA row and the classifier table.
  - A 5xx at AUTH treated as permanent: 2 fail, the 535-to-AUTH row and the classifier table.
  - A 5xx at MAIL FROM treated as permanent: 2 fail, the 550-to-MAIL-FROM row and the classifier table.
  - `message` used as the diagnostic: 7 fail, every row with a reply code and the diagnostic table.
  - The overall limit removed (`await attempt` without the race): 1 fails, the slow-server row, which then ends in `ETIMEDOUT` after about 1.3 s instead of `EDEADLINE` at 0.5 s.
  - An empty `SMTP_USER` treated as set: 2 fail, the half-login refusal (`SMTP_USER=''` with a password) and the empty-pair case.
- `classifySmtpFailure` is exported from the adapter so the classifier table can be driven directly as well as through the stub. It reads only `responseCode`, `command` and `code`, and a throwing getter yields `transient`, `EUNKNOWN`.
- `PUBLIC_BASE_URL` accepts its origin with or without one trailing slash and is normalised to the origin. Credentials, a path, a query, a fragment or a non-http(s) scheme are refused. Neither refusal quotes the value. `SMTP_HOST` and `SMTP_FROM` also take `minLength: 1`, so an empty one fails boot rather than failing every send.
- Mailpit stores the message before its 250, as assumed: the integration test reads straight after `send` resolves. `messagesTo` still takes an optional `{ atLeast, timeoutMs = 2000 }` for a later story that waits on worker-sent mail. Mailpit returns `Text` with CRLF line endings as well as the trailing newline, so the test normalises CRLF and trims.
- The stub's refusals echo the command's argument, as real servers quote the refused address, so a diagnostic built from the reply text would carry the recipient and `assertNoRecipient` would catch it.
- `src/modules/notification/index.ts` holds only the `Dependencies` declaration; dependency-cruiser reports no violation for it.
- Review fixes:
  - requireTLS: with a login and `secure: false` the transport sets `requireTLS: true`, so a login is never sent in cleartext. New case "never sends a login in cleartext to a server that offers no STARTTLS" (transient, no AUTH received); it fails with the option removed. The stub gained `starttls: { key, cert }`, and the 535-to-AUTH row now upgrades with a leaf from a throwaway CA that the spec trusts through `tls.setDefaultCACertificates` while it runs.
  - SMTP_FROM: `resolveEmailSettings` refuses at boot unless `parseFromAddress` (nodemailer's addressparser) finds exactly one mailbox with a non-empty local part and domain. The refusal names SMTP_FROM and quotes nothing. New rows: `WatchDog`, `watchdog@`, `@localhost` and `a@b, c@d` refused, `"WatchDog" <a@b.c>` accepted. "refuses anything but exactly one address" fails with the check removed.
  - httpOrigin: bareness is decided from the parsed URL (pathname `/`, empty search, hash, username and password), and the result is still `url.origin`. New accepted rows: `https://Status.Example.com` and `https://status.example.com:443`, both normalised to `https://status.example.com`. The "accepts a bare http(s) origin" case fails with the raw-string comparison restored.
  - Timeouts merge per key with `??`. New case "uses the overall default when an override is undefined"; it fails with the spread merge restored (EDEADLINE at once).
  - `SMTP_TIMEOUTS` is pinned to the spec's values, with `overall < 60_000` and `socket < overall`. The stub gained `silentAfter`; a new case stops replying after EHLO with `socket` 300 ms under an `overall` of 3 s and expects `ETIMEDOUT`. It fails with `socketTimeout` removed (EDEADLINE at 3 s).
  - Elapsed times in the spec use `performance.now()`, not `Date.now()`.
  - New case "catches the abandoned send when it fails after the deadline": an `unhandledRejection` listener, EDEADLINE from a slow stub, then the stub closed so the abandoned send fails; the listener sees nothing and is removed after.
  - The local-refusal case pins `transient`, `EENVELOPE`, and asserts the result does not contain `not an address`.
  - The integration test reads with `messagesTo(to, { atLeast: 1 })`, and compares Mailpit's `From.Name` and `From.Address` with `parseFromAddress(env.email.from)`.
  - The deferred-work entry for 6.7 now covers the lease per claimed row, the lease as the `next_attempt_at` bump set from `NOTIFICATION_RETRY_BASE_SECONDS`, a once-logged settings-class diagnostic for a 5xx at login or MAIL FROM, and the abandoned socket outliving the shutdown wait. The `SMTP_TIMEOUTS` comment names the claim lease in the same terms.

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-21). Reviewers: blind-hunter (B), edge-case-hunter (E), verification-gap (V). The claims marked "confirmed by probe" were run against the stub.

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | B7/E2: a login is sent in cleartext when the server offers no STARTTLS | medium | Confirmed by probe: auth set, `secure: false`, a stub that does not advertise STARTTLS, and `AUTH PLAIN` arrives in cleartext. nodemailer's `requireTLS` is unset | patch |
| 2 | B6/E6: a malformed `SMTP_FROM` boots, then sends wrong mail | medium | Confirmed by probe: `WatchDog` sends `MAIL FROM:<>` and is accepted, so mail goes out with a null sender. `watchdog@` is sent as given. Only `minLength: 1` is checked | patch |
| 3 | B13/E7: a valid `PUBLIC_BASE_URL` (uppercase host, `:443`) is refused | low | Confirmed by probe: both are refused, because `httpOrigin` compares the raw string with `url.origin`. Correcting the comparison is direct | patch |
| 4 | E4: `{ overall: undefined }` replaces the default | low | Confirmed by probe: the send reports `EDEADLINE` at once. A per-key `??` corrects it directly | patch |
| 5 | V1: no test pins `SMTP_TIMEOUTS` or the socket-inactivity wiring | low | Pre-verified gap. Deleting `socketTimeout` or raising `overall` to 90 s passes every test | patch |
| 6 | V other: slow-server spec times with `Date.now()` | low | AGENTS.md: the WSL clock steps back up to 1.4 s, so the `elapsed >= 450` assertion can fail. `performance.now()` is monotonic | patch |
| 7 | B10: "the late result is caught" has no test | low | The rejection handler on `attempt` could be removed and no test would fail. Adding the test is trivial | patch |
| 8 | B11: the integration test reads Mailpit once | low | `messagesTo(to)` defaults to `atLeast: 0`. On a slow CI Mailpit, the count of 1 would flake. Pass `{ atLeast: 1 }` | patch |
| 9 | B12: the local-refusal test asserts only `outcome` | low | It pins no diagnostic, and it checks only `RECIPIENT`, which that test never sends | patch |
| 10 | B16: the integration test compares `From` with the exact `SMTP_FROM` string | low | A quoted display name in a developer's `.env` fails although delivery worked. Compare the parsed name and address | patch |
| 11 | B1/B2/B4/B9: the 6.7 deferred entry is incomplete | low | The entry ignores three things. A pass leases a batch and sends it in order, so row k's lease runs out after about k x 45 s. A settings-class failure gives 6.7 nothing to log. An abandoned socket lives until the server stops trickling. These are 6.7's concerns, and the entry is this story's own text | patch |
| 12 | B8/E1: a multi-address `to` with a partial RCPT refusal reports `accepted` | low | Real in nodemailer (`:1680-1684` proceeds to DATA when some recipients are accepted). No caller passes more than one address: 6.3 stores one validated address. The fix adds a branch | reject |
| 13 | B8/E8: `headers` can override `From`, `To`, `Subject` or `Content-Type` | low | Only internal callers set `headers` (6.3 and 6.7 set `List-Unsubscribe`). A denylist adds branches for a case no caller reaches | reject |
| 14 | B3: the diagnostic does not name the SMTP phase | low | `outcome` already separates the two `SMTP 550` cases (permanent at RCPT, transient at MAIL FROM). The diagnostic's form is fixed in the frozen block | reject |
| 15 | B5: a production deploy with no SMTP settings boots and sends to localhost | false | This is the story's own acceptance criterion: the api and worker boot when `.env` omits the settings | reject |
| 16 | E5: `EMESSAGE` over SIZE, or a 552 at MAIL FROM, is retried | low | The emails are small plain text. The frozen rule says permanent holds exactly at RCPT TO or DATA | reject |
| 17 | B15/E9: the Mailpit helper derives its URL from `SMTP_HOST` | low | Test-only. The suite runs against Compose's or CI's Mailpit on localhost. An IPv6 literal or a relay host is not a setup the suite supports | reject |
| 18 | B17: sprint status is `in-progress` while the spec is `in-review` | false | step-05 moves the sprint status to `review` when the story is presented | reject |
| 19 | B18: ARCHITECTURE 5.6 does not list the SMTP defaults | low | 5.6 names the variables, and `notification-env.ts` and `.env.example` hold the defaults. Its "every number... with the default" sentence covers delivery rules, not transport settings | reject |
| 20 | B14: `axllent/mailpit:latest` is unpinned in CI and Compose | low | Compose used `latest` before this story. CI now follows it, and the suite depends on Mailpit's `/api/v1` shapes | defer |

## Verification

**Commands:**
- `pnpm run check` -- passes
- `pnpm run test`, with `.env` and again with it moved to the scratchpad -- passes
- `docker compose up -d`, then `pnpm run test:integration` -- passes, with only postgres, mailpit and migrate running
- `pnpm run test:e2e` -- 10 scenarios pass
- `pnpm run auth:schema:check` -- passes
