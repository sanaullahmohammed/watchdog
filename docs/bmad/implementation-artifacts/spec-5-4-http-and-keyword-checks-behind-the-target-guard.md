---
title: 'Story 5.4: HTTP and keyword checks behind the target guard'
type: 'feature'
created: '2026-10-09'
status: 'done'
baseline_commit: 'f993f0fceb56d97b0763967e171cc17c6f6f4c03'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The worker cannot yet run a check. A monitor fetches a URL a tenant typed from inside the worker's network, so without a connect-time guard it could probe the database, Mailpit or a cloud metadata address (ARCHITECTURE 6.5, M6). 5.1's configure-time check is a courtesy only.

**Approach:** Two network adapters in `src/modules/monitoring/checks/` run an HTTP(S) check and a keyword check and return an outcome; they write nothing. Every host is resolved by `guarded-connect.ts`, every address is classified with the rule 5.1 already uses, and the connection is pinned to the addresses that passed, for the first request and every redirect hop.

## Boundaries & Constraints

**Always:**
- Story 5.4's seven acceptance criteria (epics.md) are the contract; ARCHITECTURE 6.5 (M6) and 6.0.1's timeout rule (M7) are the rules.
- Outcome (`check-outcome.ts`): `status` `success | failure`, `checkedAt` (a `Date` taken before the lookup), `latencyMs` (attempt start to the last response's headers for HTTP, to the end of the capped body read for keyword; null when that point was never reached), `errorCode` and `errorMessage` (both null on success; message truncated to 512 characters), `metadata` `{ statusCode, redirects }`: `statusCode` is the last status received, or null when none was; `redirects` is the number of redirects followed. Keyword adds `bytesRead`.
- Error codes, snake_case and distinct: `target_refused`, `too_many_redirects`, `invalid_redirect`, `timeout`, `dns_failure`, `connection_refused`, `tls_error`, `connection_error`, `http_status`, `keyword_missing`. A refusal's message names the reason (`loopback`, `private`, …) and, on a hop, says `redirect`; never an address that came from a lookup. Mapping: the deadline firing at any stage, lookup included, is `timeout`; a lookup that rejects or returns no address is `dns_failure`; `ECONNREFUSED` is `connection_refused`; `CERT_*`, `*_SELF_SIGNED_*`, `UNABLE_TO_*`, `ERR_TLS_*` and `ERR_SSL_*` are `tls_error`; any other socket or parser error (`ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`, …) is `connection_error`.
- Refusal rule: one exported function in `domain/target-safety.ts` returns the blocked reason for an address after the allowed ranges are applied, or null. 5.1's `assertTargetAllowed` uses it too, so configure time and connect time cannot disagree. IPv4-mapped IPv6 classifies as its IPv4 address (existing `normalise`).
- Resolution at check time uses the cancellable `Resolver` (`resolve4` and `resolve6`, as 5.1's configure-time default does), cancelled when the deadline fires, so a silent DNS server cannot hold a libuv threadpool thread past the check (`dns.lookup` would, and postgres.js needs that pool to reconnect). `/etc/hosts` and search domains are therefore not seen at check time either. Decided by the owner, 2026-10-09. `localhost` and `*.localhost` count as 127.0.0.1 and ::1 without a lookup, as at configure time. Each URL's host, the first and every `Location`, is normalised as `parseTarget` does (brackets stripped, one trailing dot dropped, WHATWG IPv4 forms already dotted), so `[::1]` and `localhost.` are not mistaken for names. An IP-literal host is classified without a lookup. If any resolved address is refused, the check is refused before any socket opens. The request receives a `lookup` that returns only the addresses already classified, so nothing resolves twice.
- The lookup is injectable (5.1's `HostLookup` type); `allowedRanges` is a required argument. The check reads no configuration itself; 5.8/5.9 will pass `config.monitor.allowedCidrs`.
- One deadline, `timeout_seconds`, bounds lookup, connect, TLS, headers, redirects and body. Missing it is `timeout`.
- `node:http`/`node:https` with a fresh agent per request, `keepAlive: false`, no proxy, method `GET`, `accept-encoding: identity`, a fixed `user-agent`. TLS verification stays on.
- Success is a final 2xx. Redirects follow 301, 302, 303, 307 and 308 with a `Location`, resolved against the current URL, at most 5 hops; a sixth is `too_many_redirects`. A `Location` that is missing, unparsable, not http(s) or carries userinfo is `invalid_redirect`. Each hop goes through the guard.
- Keyword: final 2xx, then read at most 1 MiB (1 048 576 bytes) of the body and destroy the response; the keyword must occur in those bytes decoded as UTF-8, case-sensitive. A plain HTTP check does not read the body.
- `src/shared/testing/test-endpoints.ts`: one local server on `127.0.0.1:0` with 2xx, 5xx, silent, redirect-chain, redirect-to-URL and sized-body routes, counting connections and requests; plus a port nothing listens on. Later suites reuse it.
- Close the 5.1 deferred-work entry targeting this story: a spawned-process test proves `MONITOR_ALLOWED_CIDRS` reaches `config.monitor.allowedCidrs`, and that an invalid entry stops `api` and `worker` at boot. Remove the entry.

- Decided by the owner, 2026-10-09: keyword matching is case-sensitive; at most 5 redirects and a 1 MiB keyword read, fixed in code; the spec is kept whole above the token guideline.

**Never:** a write to any table; a check-results repository or command (5.6); TCP or SSL checks (5.5); scheduling or worker wiring (5.8, 5.9); a new dependency (no `undici` package); reusing a pooled agent across checks; any read of `process.env`; editing an applied migration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 2xx | `/ok`, `127.0.0.0/8` allowed | success, `statusCode` 200, latency set | N/A |
| 5xx | `/error` | failure `http_status`, `statusCode` 503 | N/A |
| Refused port | port nothing listens on | failure `connection_refused` | N/A |
| Silent | `/silent`, timeout 1 s | failure `timeout`, returns in about 1 s | N/A |
| Keyword present / absent / past cap | body sizes around 1 MiB | success / `keyword_missing` / `keyword_missing`, `bytesRead` ≤ 1 MiB | N/A |
| Blocked literal | `http://127.0.0.1:p/`, `http://[::ffff:127.0.0.1]:p/`, empty list | failure `target_refused`, server sees 0 connections | N/A |
| Blocked by lookup | injected lookup → 127.0.0.1, 10.0.0.1, 169.254.169.254, 0.0.0.0, 224.0.0.1, ::ffff:127.0.0.1 | `target_refused` each; 0 connections | N/A |
| DNS changed | monitor created with lookup → public address; check's lookup → 127.0.0.1 | `target_refused` | N/A |
| Redirect hop blocked | allowed `127.0.0.1/32`, `/redirect-to` → `127.0.0.2` host | `target_refused`, message says redirect, 1 request seen, `statusCode` 302 | N/A |
| Too many hops | 6 redirect responses, then a 200 | `too_many_redirects`, `redirects` 5, requests 1-6 seen, no 7th | N/A |
| Disguised hop | redirect to `http://0x7f.1:p/`, empty list | `target_refused`, message says redirect | N/A |
| Lookup fails | injected lookup rejects | `dns_failure` | N/A |

</frozen-after-approval>

## Code Map

- `src/modules/monitoring/domain/target-safety.ts` -- `classifyAddress`, `normalise`, `allowedList`, `HostLookup`; add the exported reason-after-allow function and make `assertTargetAllowed` use it. Keep `parseTarget` and the configure-time `Resolver` unchanged
- `src/modules/monitoring/domain/target-safety.spec.ts` -- extend: mapped forms, allowed ranges, `localhost`
- `src/config/allowed-cidrs.ts` -- `AllowedCidr`, `parseAllowedCidrs`; unchanged
- `src/config/env.ts:57,76,104-107` -- `config.monitor.allowedCidrs`
- `src/modules/monitoring/domain/monitor-limits.ts` -- `MONITOR_LIMITS.timeoutSeconds`; the two new caps go beside it
- `src/modules/monitoring/commands/create-monitor/create-monitor.handler.ts:39` -- configure-time call; it takes no lookup, so the "DNS changed" row shows configure-time acceptance with `assertTargetAllowed` and an injected lookup, then runs the check with a different one
- `src/worker-health.integration.test.ts:293` -- spawned-process pattern for the boot test
- `.dependency-cruiser.js` -- no folder allowlist; avoid `route`, `resolver`, `dtos`, `handler`, `database` in new names. `checks/` importing `domain/` is allowed; `no-orphans` only warns

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/monitoring/domain/target-safety.ts` (+ `.spec.ts`) -- shared refusal function; unit cases for every blocked class, mapped forms, allowed override
- [x] `src/modules/monitoring/domain/monitor-limits.ts` -- `MAX_REDIRECTS = 5`, `KEYWORD_BODY_CAP_BYTES = 1_048_576`, `ERROR_MESSAGE_MAX = 512`
- [x] `src/modules/monitoring/checks/check-outcome.ts` -- outcome type, error-code union, `truncateMessage`, Node error to code mapping
- [x] `src/modules/monitoring/checks/guarded-connect.ts` -- resolve and classify under the deadline; pinned `lookup` for `http.request` (both `all` forms)
- [x] `src/modules/monitoring/checks/http-check.ts` -- request, redirects, deadline, outcome
- [x] `src/modules/monitoring/checks/keyword-check.ts` -- reuses the HTTP request path; capped read
- [x] `src/shared/testing/test-endpoints.ts` -- the server and the dead port
- [x] `src/modules/monitoring/http-checks.integration.test.ts` -- every AC and matrix row; the same checks with an empty list are refused
- [x] `src/config/allowed-cidrs.integration.test.ts` (or beside the worker-health suite) -- the spawned-process config and boot tests; remove the deferred-work entry

**Acceptance Criteria:**
- Given story 5.4's seven criteria in epics.md, when the named tests run, then each is proven, and `pnpm run check` shows no new dependency-cruiser error for `checks/`.

## Implementation Notes

- Implemented by a Sonnet subagent from this spec; the main session read the whole diff against every task, AC and matrix row, then sent review pass 1's ten patches back to the same subagent and read them.
- The matrix's "Disguised hop" row reads "empty list", which cannot reach a hop: the first request to 127.0.0.1 is refused. The test allows `127.0.0.1/32` and redirects to `0x7f.0.0.2`, which keeps the row's intent.
- `EPROTO` with "SSL routines" in its message (a TLS client meeting a plain server) maps to `tls_error`; the spec's list did not name it.
- A first URL that does not parse, or that `parseTarget` refuses, is `target_refused`; a bad `Location` is `invalid_redirect`.
- Socket-error messages name the code and the URL's host, never the dialled address (review B4).
- `src/shared/testing/test-tls-cert.pem` and `test-tls-key.pem` are a self-signed test pair for `127.0.0.1`, valid to 2126, used only by the test server. 5.5 can reuse them.
- Verification (main session, 2026-10-16), after a `docker compose up -d` that also started `api` and `worker`; both were stopped before testing:
  - `pnpm run check` is clean, with the 11 warnings from before and none in touched files.
  - Unit tests pass 211 of 211, with and without `.env`.
  - Integration runs 1 and 2 failed (19 and 18 failures, 410 cancelled), because Postgres was not running. These are not code failures.
  - Run 3 failed one test of 486, "stamps checkedAt when the attempt starts". That test compared `checkedAt` with the end time, and the journal showed "Time jumped backwards" during the run. The file passed 3 of 3 on its own, and run 4 passed 486 of 486. The test now compares `checkedAt` with the moment the lookup starts, and passed 3 of 3 alone.
  - Runs 5 and 6 passed 486 of 486.
  - e2e passed 42 of 42 steps, and `auth:schema:check` is in sync.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1 | No test shows each check and hop opens its own connection | medium | Every `connections()` assertion is a refused case at 0; swapping in the keep-alive global agent stays green. patch (count connections on `/ok` twice and `/chain/3`) |
| V2/B7 | Certificate verification and the `CERT_*`/self-signed mapping are never exercised | medium | The only TLS test hits a plain server (`EPROTO`); `rejectUnauthorized: false` would pass. patch (HTTPS route with a committed self-signed test certificate in `test-endpoints.ts`; untrusted certificate is `tls_error`) |
| V3/B6 | Body-stage timeout, keyword latency to body end, and one deadline across slow hops are untested | medium | No route stalls after headers or delays a hop. patch (slow-body and delayed-chain routes; assert `timeout`, `latencyMs` null, latency ≥ delay, chain bounded) |
| V4/B10 | The pinned lookup's single-address form never runs; `as never` hides the type | low | Node 24 always asks with `all: true`. patch (`guarded-connect.spec.ts` calls both forms directly) |
| V5 | `accept-encoding: identity` and `user-agent` are not observed | low | Server records only the path. patch (record headers; assert both) |
| B4/E3 | A socket error's message names the dialled address (`connect ECONNREFUSED 10.1.2.3:80`) | medium | `messageOf` passes Node's text through; for an allowed internal range that tells the tenant what its name resolves to, against the guard's rule. patch (socket-error messages name the code and the URL host, never `error.address`) |
| B2 | Timing assertions use `Date.now()`, which steps back on WSL2 (AGENTS) | medium | `elapsed >= 900` and `checkedAt >= before` can fail on a step. patch (elapsed via `performance.now()`; `checkedAt` checked with a margin larger than 1.4 s) |
| B3/E6/E7 | Boot test resolves on `exit`, so stdio may be cut; a missing line throws a TypeError | low | Node docs: stdio may be open at `exit`. patch (`close`; assert the line exists) |
| B5 | Comment "the host is the caller's own text" is wrong on a hop | low | On a hop it comes from `Location`. patch (comment) |
| B9 | No keyword straddling the cap | low | Cases sit wholly inside or outside. patch (keyword starting at cap − 3 is `keyword_missing`) |
| B1 | `defaultLookup`'s 5 s Resolver limit yields `dns_failure` before a longer `timeout_seconds` | low | Real, but needs a DNS server slower than 5 s, and the fix threads a new parameter. rejected |
| B8 | "Disguised hop" is not disguised; matrix row says empty list | false | The `Location` header carries `0x7f.0.0.2` and is refused; that `URL` normalises it is the mechanism under test. The row as written cannot reach a hop with an empty list; the test keeps its intent (raised with the owner at presentation) |
| B11 | Spec and sprint-status disagree; 5.3 moved to done | false | Sprint status moves to review at step 5; the owner asked for 5.3 → done on this branch |
| B12/E8 | `deadPort` can be taken by another suite | low | Needs another listener to bind that exact ephemeral port within milliseconds; a held port cannot refuse. rejected |
| B13 | Boot test has no positive control through the entrypoints | low | Both entrypoints load the same `src/config/env.ts` the positive case loads. rejected |
| E1 | `latencyMs` keeps the previous hop's value when a later hop fails | false | Spec: latency to the last response's headers; that is the hop that answered, matching `statusCode` |
| E2 | A server ignoring `identity` and gzipping makes keyword fail | low | Unusual server behaviour; adds a branch. rejected |
| E4 | Injected lookup returning a non-IP throws `TypeError` | false | `Resolver.resolve4/6` return addresses only; only tests inject |
| E5 | `AggregateError` code taken from the first inner error only | low | Order-dependent only for mixed failures across families. rejected |
| E9 | `/body` handler throws on bad params | false | Test-only route; no caller passes them |
| E10 | Socket may buffer one chunk past the cap | low | Bytes kept and searched are capped; the stream is destroyed at the cap. rejected |

## Design Notes

Pinning the lookup closes the DNS-rebinding gap: the address classified is the address dialled, and the URL's host still drives the `Host` header and TLS SNI. Node skips `lookup` for an IP-literal host, which is why literals are classified separately before the request. Node 24's `NODE_USE_ENV_PROXY` proxies only the global agent (checked on 24.12: a fresh `http.Agent` connects directly), so the fresh agent also keeps an environment proxy from receiving a tenant's URL.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass (rerun failures 2–3× per AGENTS clock-skew rule; report all)
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
