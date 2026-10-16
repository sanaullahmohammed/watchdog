---
title: 'Story 5.5: TCP and SSL-expiry checks'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: 'b9d97dbdb9c51186909d60d623e1fa19cf03859d'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The worker can run `http` and `keyword` checks (5.4) but not `tcp` or `ssl_expiry`, two of the four types a monitor can be configured with. Both open a socket to a tenant's target from inside the worker's network, so both need 5.4's connect-time guard (ARCHITECTURE 6.5).

**Approach:** Two more adapters in `src/modules/monitoring/checks/`, `tcp-check.ts` and `ssl-expiry-check.ts`, return a `CheckOutcome` and write nothing, as 5.4's do. Both resolve and classify their host through `guarded-connect.ts` and dial only the addresses that passed. The SSL check retrieves the leaf certificate whether or not it validates. It fails only when there is no certificate or the certificate is invalid (DOMAIN, "SSL-expiry checks measure availability").

## Boundaries & Constraints

**Always:**
- Story 5.5's five acceptance criteria (epics.md) are the contract. DOMAIN's SSL result metadata and ARCHITECTURE 6.5 and 6.0.1 are the rules.
- Targets go through one pure function, `parseCheckTarget(type, target) → { host, port }`. It calls `parseTarget('tcp' | 'ssl_expiry', target)`, the configure-time parser, so the two times cannot disagree, and defaults `ssl_expiry`'s port to 443. A unit test covers that default. A target `parseTarget` refuses is `target_refused`.
- The guard is 5.4's: the same refusal function, `localhost` handling, injected `HostLookup`, required `allowedRanges` and pinned `lookup`. It runs before any socket opens. One deadline, `timeout_seconds`, covers lookup, connect and handshake. When it fires, the socket is destroyed and the outcome is `timeout`. `checkedAt` is taken before the lookup.
- TCP: success when the connection is established. `latencyMs` runs from the start of the attempt to the connect, and the socket is then destroyed. `metadata` is `{}`. A refused connection is `connection_refused`, a missed deadline is `timeout`, and any other error maps as in 5.4. "Never answers" means the TCP handshake never completes. A server that accepts and stays silent is a TCP success.
- SSL: `tls.connect` with `rejectUnauthorized: false`, so the certificate is retrieved and then judged. SNI is the host unless the host is an IP literal. `latencyMs` runs from the start of the attempt to `secureConnect`. It is set on `certificate_*` failures, as it is on 5.4's `http_status`. When the handshake succeeds, Node's `authorized`/`authorizationError` decide the outcome:
  - `CERT_HAS_EXPIRED` → `certificate_expired`
  - `CERT_NOT_YET_VALID` → `certificate_not_yet_valid`
  - `ERR_TLS_CERT_ALTNAME_INVALID` → `certificate_hostname_mismatch`
  - any other verification error → `certificate_untrusted`, with its code in the message.
- SSL metadata: `{ certificateFingerprint, certificateExpiresAt, daysRemaining }`.
  - `certificateFingerprint` is Node's `X509Certificate.fingerprint256` of the leaf: SHA-256 of the DER as uppercase colon-separated hex (`AB:CD:…`). 5.6 stores this format and 5.7 keys on it. The test compares it with `createHash('sha256')` of the leaf's DER, formatted the same way.
  - `certificateExpiresAt` is its not-after as an ISO 8601 UTC string.
  - `daysRemaining` is `Math.floor((notAfter − checkedAt) / 86 400 000)`. It is negative once the certificate has expired.
  - All three are null whenever no certificate was retrieved (guard refusal, DNS, refused, timeout, not TLS, or an empty peer certificate, which is `tls_error`). They are never zero or empty.
- An expiring but valid certificate succeeds. The check takes no `warnDays`; the warning is 5.7's.
- Messages never name a looked-up address (5.4's `messageOf` rule).
- Trust uses Node's default roots. An optional `ca` option replaces them, for tests only, as `lookup` is injectable.
- Test endpoints (`src/shared/testing/`) are local only, and nothing leaves the machine:
  - a test CA that issues leaves at runtime with chosen SANs and validity. Times are kept far from now, because the WSL2 clock steps back up to 1.4 s (AGENTS):
    - valid leaves have `notBefore` set to now − 1 day;
    - the expired leaf has `notAfter` now − 1 day;
    - the not-yet-valid leaf has `notBefore` now + 1 day;
    - the 36-hour leaf has `notAfter` now + 36 h.
  - TLS servers for valid, 36-hour, expired, not-yet-valid and wrong-host leaves;
  - a server that accepts TCP and never speaks;
  - a port whose TCP handshake never completes;
  - the existing self-signed HTTPS server serves as the untrusted case, and the existing HTTP server as the accepting TCP target and the not-TLS target.
- Decided while planning, 2026-10-16:
  - The certificate dev dependency is `node-forge` (with `@types/node-forge`), added with `pnpm install --lockfile-only`.
  - `.dependency-cruiser.js`'s `not-to-dev-dep` exempts `^src/shared/testing/`, since its own comment directs a dev-only module there.

**Never:** a write to any table; a check-results repository or command (5.6); the SSL warning or `monitor_ssl_warnings` (5.7); scheduling or worker wiring (5.8, 5.9); any read of `process.env` or configuration; a change to `http-check.ts` or `keyword-check.ts` behaviour; editing an applied migration; a test that reaches a non-local address.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TCP accepts | HTTP server's port, `127.0.0.0/8` allowed | success, latency set, 1 connection seen (the test waits for the server's `connection` event before counting) | N/A |
| TCP refused | dead port | `connection_refused` | N/A |
| TCP never answers | handshake-never-completes port, timeout 1 s | `timeout` in about 1 s | N/A |
| TCP guard | same accepting target, empty list; injected lookup → 10.0.0.1 | `target_refused`, 0 connections | N/A |
| SSL valid | CA-signed leaf for `watchdog.test` and `127.0.0.1`, CA trusted; by name (injected lookup) and by IP | success; fingerprint = SHA-256 of the leaf's DER; expiry = its not-after; days floored | N/A |
| SSL 36 hours (AC 2 example, and AC 3: inside any `warnDays` ≥ 2) | leaf expiring 36 h after issue | success, `daysRemaining` 1 | N/A |
| SSL invalid | untrusted (self-signed), wrong host, expired, not yet valid | `certificate_untrusted` / `_hostname_mismatch` / `_expired` / `_not_yet_valid`; all three fields set | N/A |
| SSL no certificate | refused port, silent server (timeout 1 s), plain HTTP server, guard refusal | `connection_refused` / `timeout` / `tls_error` / `target_refused`; all three fields null | N/A |

</frozen-after-approval>

## Code Map

- `src/modules/monitoring/checks/guarded-connect.ts` -- `guardTarget(url, …)` parses with `parseTarget('http', …)`, then resolves and classifies. Extract `guardHost(host, options)` from it, so a host:port target is guarded the same way. `guardTarget` keeps its behaviour and errors. `PinnedLookup` serves `net`/`tls` `lookup` too.
- `src/modules/monitoring/checks/check-outcome.ts` -- add the four `certificate_*` codes to `CHECK_ERROR_CODES`, plus `TcpCheckMetadata` and `SslExpiryCheckMetadata`. `codeForNodeError` and `messageOf` are reused unchanged. `error_code` is plain `text` in the migration, so no schema change.
- `src/modules/monitoring/checks/http-check.ts` -- reference only: deadline (`AbortController` plus timer), `checkedAt`/`performance.now()` pattern, `failure` helper. `HttpCheckOptions` (`timeoutSeconds`, `allowedRanges`, `lookup?`) is the option shape to reuse.
- `src/modules/monitoring/domain/target-safety.ts:111` -- `parseTarget(type, target): { host, port? }`. Host is lower-cased, unbracketed and has no trailing dot. It throws `InvalidMonitorInputError` and leaves the `ssl_expiry` port undefined. Do not change it.
- `src/shared/testing/test-endpoints.ts` -- `startTestEndpoints()`: HTTP server (`port`, `connections()`), self-signed `httpsOrigin` (cert at `test-tls-cert.pem`, `127.0.0.1`, to 2126), `deadPort`. Extend it, without changing existing routes.
- `src/modules/monitoring/http-checks.integration.test.ts` -- suite pattern to follow: `parseAllowedCidrs('127.0.0.0/8')`, `answering(...)` lookup, `before`/`after` server lifecycle, `performance.now()` for elapsed time (AGENTS clock-skew).
- `.dependency-cruiser.js:235` -- `not-to-dev-dep`, whose `from.pathNot` gets the `src/shared/testing` exemption. `not-to-spec` forbids importing `*.test.ts`, so helpers cannot be named that way.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `pnpm-lock.yaml` -- dev deps `node-forge`, `@types/node-forge`; `pnpm install --lockfile-only`, then `pnpm install`
- [x] `.dependency-cruiser.js` -- exempt `^src/shared/testing/` from `not-to-dev-dep`; `from.pathNot` is one regex today, so add it by alternation (or make it an array)
- [x] `src/modules/monitoring/checks/guarded-connect.ts` (+ `.spec.ts`) -- extract `guardHost`; unit case that a host refused by `guardHost` gives the same message as through `guardTarget`
- [x] `src/modules/monitoring/checks/check-outcome.ts` -- codes and metadata types
- [x] `src/modules/monitoring/checks/guarded-connect.ts` -- `parseCheckTarget(type, target)` for `tcp` and `ssl_expiry`, unit-tested in `guarded-connect.spec.ts` (443 default, explicit port, bracketed IPv6, refusal)
- [x] `src/modules/monitoring/checks/tcp-check.ts` -- `runTcpCheck(target, options)`
- [x] `src/modules/monitoring/checks/ssl-expiry-check.ts` -- `runSslExpiryCheck(target, options & { ca? })`, plus an exported pure `daysRemaining(notAfter, checkedAt)` with a `.spec.ts` covering 36 h → 1, exactly 24 h → 1, 23 h → 0 and −1 h → −1
- [x] `src/shared/testing/test-certificates.ts` -- `createTestCa()` → `{ caPem, issue({ dns?, ip?, notBefore, notAfter }) → { certPem, keyPem } }`; RSA keys from `node:crypto`, signed by forge
- [x] `src/shared/testing/test-endpoints.ts` -- `startTlsServer({ certPem, keyPem })` → `{ port, connections(), close() }`; `startSilentTcpServer()`; `startUnansweredTcpPort()`. This is a child Node process that listens on `127.0.0.1` with backlog 1, then blocks its event loop with `Atomics.wait`, which does not spin a CPU. It exits by itself after 120 s. The helper opens filler connections, each probed with a 300 ms limit, until one stalls, and keeps them all open. Closing it destroys the fillers and kills the child. Backlog must not be 0, which Node treats as the default of 511.
- [x] `src/modules/monitoring/tcp-ssl-checks.integration.test.ts` -- every AC and matrix row

**Acceptance Criteria:**
- Given story 5.5's five criteria, when `tcp-ssl-checks.integration.test.ts` runs, then each is proven, and `pnpm run check` shows no new error.

## Design Notes

`rejectUnauthorized: false` is what makes the metadata possible on a failed check. Node still runs chain verification and then `checkServerIdentity` (only when the chain passed), and records the first failure in `authorizationError` instead of destroying the socket. So one defect per test leaf gives one deterministic code. A leaf with both a bad chain and a bad name reports the chain. This was verified on Node 24.12 during planning: expired gave `CERT_HAS_EXPIRED`, future `CERT_NOT_YET_VALID`, wrong SAN by name and by IP `ERR_TLS_CERT_ALTNAME_INVALID`, and self-signed `DEPTH_ZERO_SELF_SIGNED_CERT`. `checkServerIdentity` was skipped when the chain failed. A pinned `lookup` was used for a name host. Two cases map differently from what the name suggests:
- An expired intermediate also reports `CERT_HAS_EXPIRED`.
- A self-signed expired leaf reports untrusted.

Both are harmless, because 5.7's warning reads the leaf's timestamps, not the code.

A TCP handshake that never completes cannot be made with a Node server in-process, because libuv accepts at once. A listener whose process never calls `accept` fills the kernel's accept queue. Linux then drops further SYNs, so the client waits until its own deadline. Verified during planning: with backlog 1, two fillers connected and the third hung. The mechanism is Linux-specific; CI and the WSL2 machine are both Linux. The child's self-exit means an aborted test run cannot leave it behind.

`tsconfig.build.json` compiles all of `src` except unit specs, so `dist` already carries the test helpers and integration suites. `test-certificates.js` joins them. Nothing in the runtime imports `src/shared/testing`, so the missing `node-forge` in the production image is never loaded. The build stage installs dev dependencies, so `tsc` sees the types.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `timeout 900 pnpm run test:integration` -- pass (rerun failures 2–3× per the AGENTS clock-skew rule; report all)
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass

## Implementation Notes

- A Sonnet subagent implemented this from the spec. The main session read the whole diff against every task and matrix row. It then sent the 16 patches from review pass 1 back to the same subagent and read them.
- SNI is recorded in the test TLS server's `SNICallback`, not from `socket.servername`. The client destroys its socket straight after `secureConnect`, before the server's handshake callback runs, so that field was never read.
- The port holder is started inside the one TCP timeout test, not in `before()`, so its 120 s self-exit cannot overtake the suite.
- `node-forge` is pinned to 1.4.0 and `@types/node-forge` to 1.3.14. A new `not-to-testing-helpers` dependency-cruiser rule stops runtime code from importing `src/shared/testing`, which closes the hole the dev-dependency exemption opened.
- The empty-peer-certificate branch (`tls_error`, null metadata) has no test. Producing it needs an anonymous cipher suite, which Node's defaults and TLS 1.3 refuse (triage B15/V4).
- Verification, main session, 2026-10-16, with only postgres and mailpit running:
  - Implementer's first full integration run, before the review patches: 2 failures in the incident module ("never reopens a resolved incident when conflicting moves race" and "orders a timeline deterministically when entries share a timestamp"). The incident files then passed 3 of 3 reruns, and the next full run passed 501 of 501. This matches the known WSL2 clock steps.
  - After the patches:
    - `pnpm run check` is clean (11 warnings from before, none in touched files; no dependency violations).
    - Unit tests pass 217 of 217, with and without `.env`.
    - `timeout 900 pnpm run test:integration` passed 504 of 504.
    - `tcp-ssl-checks.integration.test.ts` passed 18 of 18, three times alone.
    - e2e passed 3 scenarios and 42 steps.
    - `auth:schema:check` is in sync.
    - No port-holder process was left running.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap, M = main session.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1 | SNI is untested: dropping `servername` (or sending an IP as SNI) breaks no test | medium | Pre-verified on Node 24.12: Node sends no SNI unless `servername` is given, and no test server reads SNI. patch: `startTlsServer` records each connection's `servername`; assert `watchdog.test` by name and `false` by IP |
| V2 | TCP never dials a name, so dropping the pinned `lookup` breaks no test | medium | Every connecting TCP test uses an IP literal, which skips `lookup`. patch: by-name TCP success through `answering('127.0.0.1')`, 1 connection |
| B1/E4/V3 | The `src/shared/testing` exemption lets runtime code import `node-forge` unchecked; `--prod` image would fail at boot | medium | No rule forbids non-test `src` importing `src/shared/testing`; Dockerfile:21 installs `--prod`. patch: `not-to-testing-helpers` rule (from `^src` minus spec/test files and `^src/shared/testing/`, to `^src/shared/testing/`) |
| B3/E7/M1 | `daysRemaining === 89` on a 90-day leaf reads 90 after a WSL2 clock step-back | medium | `notAfter = now + 90 d`; a `checkedAt` stepped back 1.4 s exceeds 90 d. patch: `notAfter` `now + 90 d − 12 h`, expect 89 |
| B2/E2 | Expiry is parsed from the `validTo` text, implementation-defined in V8 | low | `new Date(validTo)` on `"Jan  1 00:00:00 2035 GMT"`; `X509Certificate.validToDate` exists on 24.12. patch: use `validToDate` |
| E1 | `new X509Certificate(raw)` throwing inside the `secureConnect` listener escapes as an uncaught exception | low | The listener runs outside the executor; a throw there crashes the process. OpenSSL re-encodes its own parsed cert, so unlikely, but the fix is direct. patch: try/catch → reject `tls_error` |
| B4 | Hostname mismatch is tested by IP only | low | `wrongHost` dials `127.0.0.1`. patch: also `watchdog.test` against a leaf without that SAN |
| B5/M3 | Untrusted case asserts only the fingerprint | low | Matrix says all three fields set and latency is set on `certificate_*`. patch: assert expiry, numeric days, latency |
| B6 | No DNS-failure or hanging-lookup case for either adapter | low | 5.4 has both for HTTP; the SSL "no certificate" list names DNS. patch: rejecting lookup → `dns_failure` + null metadata (SSL), never-settling lookup → `timeout` (TCP) |
| B7 | Named TCP guard case resolves to 10.0.0.1, so the 0-connection count cannot catch a bypass | low | A bypass would dial 10.0.0.1, not the endpoint. patch: `answering('127.0.0.1')` with `NONE` |
| B8 | Dead third column in `invalid`, a no-op `endpoints.reset()`, a duplicated guard case | low | Read in the diff. patch: delete the column and the reset; keep one guard test that counts connections |
| B9 | SSL timeout has no elapsed bound | low | TCP's has 900–3000 ms. patch: same bound |
| B11/E5 | Port holder self-exits at 120 s; a late test would see `connection_refused` | low | Started in `before()`; fine today, but moving the start into the one test that uses it is a direct change. patch: start and close it inside the TCP timeout test |
| B12 | `startTlsServer` registers two `connection` listeners | low | Read in the diff. patch: one listener before `listen` |
| B13 | `codeForAuthorization` repeats the `certificate_*` codes as a hand-written union | low | Second list beside `CHECK_ERROR_CODES`. patch: `Extract<CheckErrorCode, \`certificate_${string}\`>` |
| B14 | `node-forge` added with a caret range | low | Most dev tooling is pinned exactly. patch: pin `node-forge` and `@types/node-forge` exactly |
| B10 | Deadline logic duplicated across adapters; abort listener added without checking `aborted` | low | The guard's own `onAbort` rejects an abort during lookup, and no macrotask can run between the guard resolving and the listener being added, so no outcome is wrong; dedup is a refactor. rejected |
| E3 | An expired intermediate reports `certificate_expired` while the leaf's days are positive | low | Spec Design Notes accept it: the check correctly fails, and 5.7 reads the leaf's timestamps. Splitting the code adds a branch. rejected |
| E6 | Port holder not killed if the child prints a non-number or `connect` throws synchronously | low | The child prints `server.address().port`, and `connect` to a valid port does not throw synchronously. Adds guards. rejected |
| B15/V4 | Empty-peer-certificate `tls_error` branch is untested | low | Needs an anonymous cipher suite, which Node's defaults and TLS 1.3 refuse; branch is near-unreachable and costly to stage. rejected |
| M2 | `once('error')` leaves a second socket error unhandled | false | A socket emits `error` while destroying itself, then emits no more; on success the listener stays attached until `finally` destroys without an error |
