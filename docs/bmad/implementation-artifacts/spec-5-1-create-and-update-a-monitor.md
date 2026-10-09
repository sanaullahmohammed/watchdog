---
title: 'Story 5.1: Create and update a monitor'
type: 'feature'
created: '2026-10-09'
status: 'done'
baseline_commit: 'd211144068846a894e2baadb8720a2fec151f886'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no `monitoring` module, so an operator cannot configure a synthetic check for a service. Story 5.1 (epics.md) adds the `monitors` table and the `CreateMonitorCommand` / `UpdateMonitorCommand` pair over REST and GraphQL.

**Approach:** One migration, one `monitoring` module with two command slices on the service-slice pattern, a pure derived-state rule in `src/shared/domain/monitor-state.ts`, event contracts in `src/shared/events/monitor.events.ts`, and a configure-time target courtesy check (ARCHITECTURE 6.5) with an allowed-CIDR list from `src/config`.

## Boundaries & Constraints

**Always:**
- Story 5.1's acceptance criteria (epics.md) are the contract; DOMAIN Monitor (incl. 2026-10-09) and M1 set the rules. Decisions land in DOMAIN / ARCHITECTURE first (AGENTS policy).
- Bounds, recorded in DOMAIN's Monitor table and enforced by both the schema and DB CHECKs: `interval_seconds` 30–86400 (default 60); `timeout_seconds` 1–60 (default 10), below `interval_seconds`; `failure_threshold` 1–20 (default 3); `config.warnDays` 1–365; `name` 1–120; `target` 1–2048; `config.keyword` 1–256 with a non-space character; `enabled` default true. Creating a monitor on an archived service is allowed (5.8 skips it).
- Targets, recorded in DOMAIN's `target` row: `http`/`keyword` an absolute `http:`/`https:` URL with no userinfo; `tcp` `host:port` (port 1–65535); `ssl_expiry` `host` or `host:port` (443 at check time). IPv6 is bracketed everywhere. `keyword` needs `config.keyword`, `ssl_expiry` needs `config.warnDays`, a key for another type is refused. GraphQL `type` is a `String`, refused by the handler's TypeBox literal union.
- Update: `type` is absent from the update schema; an absent key is left alone; `config` replaces the stored object whole; an update that changes no stored value returns the id and emits nothing, because DOMAIN says `*.updated` announces a change, not an attempt (owner, 2026-10-09, review loop 1). Re-enable resets first, then states are computed, so re-enable plus a threshold change ends at null.
- Every refusal is a 400 naming the field on both surfaces, before SQL or emit: GraphQL and the domain's cross-field rules say `Invalid input. <field>: …`; REST's schema-stated rules answer with Fastify's validation error naming the field, as every slice does (owner, 2026-10-09, review loop 1). Unknown/foreign `serviceId` → 400 naming the service; unknown/foreign monitor id on update → 404.
- Courtesy check: `localhost` and `*.localhost` count as 127.0.0.1 and ::1 without a lookup, and the allowed list then applies to them like any address (owner, 2026-10-09, review loop 1). A refusal names the host and the reason, never an address that came from a lookup. Every resolved address is classified and one blocked address refuses. Blocked: loopback, private (RFC 1918, fc00::/7), link-local (169.254/16, fe80::/10), unspecified (0.0.0.0/8, ::/96 incl. IPv4-compatible), broadcast 255.255.255.255, multicast; IPv4-mapped forms classify as IPv4. An address inside `MONITOR_ALLOWED_CIDRS` (comma-separated, empty default, invalid entry fails boot) is allowed. A lookup that fails (NXDOMAIN) or exceeds 5 s accepts: the connect-time guard (5.4) is the guard. NAT64 and CGNAT are not classified; ARCHITECTURE 6.5 says so.
- Derived state: `monitorStateOf({ enabled, lastCheckedAt, consecutiveFailures, failureThreshold })` is null when disabled or `lastCheckedAt` is null, else M1. Story 5.6 passes the new `lastCheckedAt` into "after"; the DOMAIN sketch is corrected to show it. Update locks the row `for no key update`, emits `monitor.updated`, then `monitor.state_changed` only when the state moved; entering `failing` increments `failure_episode`. Re-enabling (false→true) resets `consecutive_failures` 0 and `last_checked_at` null, never `failure_episode`. No edit emits `monitor.threshold_breached`.
- Payloads: all carry `orgId`, `monitorId`, `serviceId`, `monitorName`; `state_changed` adds `from`, `to` (state or null) and `failureEpisode`.

**Never:** monitor delete or a monitor read (5.2); network checks (5.4); DNS while holding the row lock; a JSON GraphQL scalar (config is a typed input); importing another module; real DNS for a valid target in tests (fixtures use 203.0.113.0/24 literals).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected |
|---|---|---|
| Create each type | valid body | 201 `{id}`, counters 0/null, `monitor.created` |
| Bad config | per AC list, REST + GraphQL | 400 naming field, no row, no event |
| Blocked target | `http://localhost/`, `10.0.0.1:22`, `[::ffff:7f00:1]` | 400 naming refusal |
| Allowed range | blocked address inside allowed CIDR | accepted (unit) |
| Disable degraded | failures 1/threshold 3 → enabled false | `state_changed` degraded→null |
| Threshold into failing | failures 2, threshold 3→2 | `state_changed` degraded→failing, episode +1 |
| Re-enable | disabled, failures 4 | failures 0, last_checked null, episode kept, no state event |

</frozen-after-approval>

## Code Map

- `src/modules/service/commands/{create,update}-service/*` -- slice pattern to copy: handler (`assertMatchesSchema`, `assertUuid`, emit after commit, returns id), route (`/v1/...`, `resolveOrganizationContext`, 201/200 `idDtoSchema`), resolver (`ErrorWithProps UNAUTHENTICATED`), schema (one TypeBox object), SDL (input + `Mutation` returning `ID!`)
- `src/modules/service/{index.ts,service.mapper.ts,database/service.repository.ts}` -- `Dependencies` augmentation + action creator; row mapper; FK 23503 translation
- `src/server/di/index.ts` -- autoloads `*.{repository,mapper,domain}.ts` and `*.handler.ts` by camelCased file name; no registration list
- `src/shared/domain/status-inputs.ts:21-28` -- `MONITOR_DERIVED_STATES` / `MonitorDerivedState` already exist; reuse, do not redeclare
- `src/shared/validation/typebox-guard.ts` -- message format the 9.11 registry matches: `^Invalid input\.(?:.*; )?<field>: `
- `src/shared/api/graphql-mutations.integration.test.ts:99` -- registry; add `createMonitor`, `updateMonitor`
- `src/shared/api/contract/api-surface-parity.spec.ts` -- compares top-level names only; `.schema.ts` must export exactly one `Type.Object`, so the shared config object lives in domain
- `src/modules/service/service-input-validation.integration.test.ts:49-110` -- `assertRefused` / `refused` pattern
- `src/config/env.ts` -- add `MONITOR_ALLOWED_CIDRS` and cross-field validation; `.env.example` documents it
- Node `net.BlockList` matches IPv4-mapped IPv6 against IPv4 subnets (verified on Node 24); no new dependency

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/DOMAIN.md` (Monitor bounds, defaults, target formats, never-checked rule, sketch `lastCheckedAt`), `docs/genesis/ARCHITECTURE.md` 6.5 (variable name, NAT64/CGNAT omission) -- decisions first
- [x] `db/migrations/<ts>_create_monitors.sql` -- table per DOMAIN with defaults (`consecutive_failures` 0, `failure_episode` 0, `config` `'{}'`), `monitors_type_ck`, bound CHECKs incl. `timeout_seconds < interval_seconds`, `unique (id, org_id)`, FK `(service_id, org_id)` → `services (id, org_id)`, index on `service_id` (5.8 adds its due index), RLS enabled + forced + policy
- [x] `src/shared/domain/monitor-state.ts` + `.spec.ts` -- `monitorStateOf`, unit-tested over M1
- [x] `src/shared/events/monitor.events.ts` -- `monitor.created`, `monitor.updated`, `monitor.state_changed`
- [x] `src/config/env.ts`, `.env.example` -- allowed CIDR list parsed and validated
- [x] `src/modules/monitoring/domain/{monitor.types.ts,monitor-limits.ts,monitor.errors.ts,monitor.domain.ts,target-safety.ts,target-safety.spec.ts}` -- types, bounds + config TypeBox object, errors, create/merge/validate, target parsing + address classification with injectable lookup
- [x] `src/modules/monitoring/{index.ts,monitor.mapper.ts,database/monitor.repository.ts}` -- insert (FK → service error), `findById`, `getForUpdate`, `update`
- [x] `src/modules/monitoring/commands/{create,update}-monitor/*` -- five files each; `POST /v1/monitors`, `PATCH /v1/monitors/:id`
- [x] `src/shared/testing/fixtures.ts` -- `createMonitor`, `setMonitorCheckState` (direct counters until 5.6)
- [x] `src/shared/api/graphql-mutations.integration.test.ts` -- two entries
- [x] `src/modules/monitoring/{monitor,monitor-input-validation}.integration.test.ts` -- every AC, plus: a staged-lock concurrency case (hold the row lock in another transaction, start two PATCHes, release) as in `incident-concurrency.integration.test.ts`; malformed `id` and `serviceId` over GraphQL refused below 500 naming the field; explicit `null` over GraphQL for `intervalSeconds`, `enabled`, `config` and `config.keyword` refused; create with non-default `enabled: false`, threshold, interval, timeout stored as sent; `enabled: true` on an enabled degraded monitor changes nothing and emits nothing; a one-field `{ timeoutSeconds }` patch refused against the stored interval; a no-op patch emits nothing; the handlers accept a blocked literal and `localhost` inside an allowed range and refuse one outside it (set `config.monitor.allowedCidrs` in that file, each test file is its own process); REST refusals assert the field structurally (message or `subErrors` path), never a loose substring

**Acceptance Criteria:** story 5.1's nine criteria in epics.md, each proven by the named tests.

## Implementation Notes

- Implemented by a Sonnet subagent from this spec; diff reviewed against every task and AC by the main session.
- Migration `20261009120000_create_monitors.sql` also CHECKs `config.warnDays` and `config.keyword` ranges; DELETE is not revoked (not asked for).
- `MONITOR_ALLOWED_CIDRS` is parsed in `src/config/allowed-cidrs.ts` and exposed as `config.monitor.allowedCidrs`; `target-safety.ts` takes the list as an argument, so unit tests need no `.env`.
- `MonitorConfigInput` (SDL) lives in `dtos/monitor-config.graphql-schema.ts`, declared once for both mutations.
- REST refusals of what the schema states come from Fastify's validation ("Validation error", field in `subErrors`); the `Invalid input. <field>:` message appears on GraphQL and for the domain's cross-field rules. Fastify's `removeAdditional` drops unknown `config` keys on REST; keys of another type are refused on both surfaces.
- Main-session fixes after review of the diff: `MonitorStatePayload` reuses `MonitorDerivedState`; `normalise` strips an IPv6 zone (`%eth0`) so a resolver answer cannot raise a masked 500.
- Verification (main session, 2026-10-09): check clean (11 pre-existing warnings, none new); unit 190/190, and 190/190 with `.env` moved aside; integration 396/396 first run, no reruns; e2e 3/3 scenarios; auth:schema:check in sync.

- Review loop 1: intent gaps found; code stashed, local migration rolled back, spec re-planned (see Spec Change Log).

- Loop 2 implementation (Sonnet subagent): restored the stash, re-applied the migration, amended per the loop-1 rules. Reviewed by the main session as an interdiff against loop 1. `Resolver` does not read `/etc/hosts`, so hosts-file-only names are not seen by the courtesy check; 5.4's connect-time guard covers them. `localhost` is accepted only when both 127.0.0.1 and ::1 are allowed, since one blocked address refuses.
- Verification loop 2 (main session, 2026-10-09): check clean (11 pre-existing warnings, none new); unit 194/194, and 194/194 with `.env` moved aside; integration 406/406 first run, no reruns; e2e 3/3; auth:schema:check in sync.

- Review pass 2 patches (implementation subagent, re-engaged): strict CIDR parsing, host character and zone-id refusals, punycoded hosts for every type, key-generic `sameConfig`, `revoke delete on monitors` in the unmerged migration (rolled back and re-applied locally), default-resolver unit tests, derived-state and `monitor.updated` tests, ARCHITECTURE 6.5 and DOMAIN no-op paragraph. The main session re-ran the pass-2 probes: all five URL-character hosts and `::ffff:10.0.0.0/8` are now refused.
- Verification after pass 2 (main session, 2026-10-09): check clean (11 pre-existing warnings); unit 201/201, and 201/201 with `.env` moved aside; integration 410/410 first run, no reruns; e2e 3/3; auth:schema:check in sync.

## Spec Change Log

- **Loop 1 (2026-10-09).** Triggered by review findings B1, B8, E13 (intent gaps, answered by the owner) and the bad_spec rows in the triage log. Amended: frozen intent (no-op update emits nothing; refusal wording matches the story; localhost under the allowed list), Design Notes (resolver, host parsing, check order, shared CIDR type, ARCHITECTURE 6.5 list, fixture assert), Tasks (added tests). Known-bad state avoided: a no-op edit announcing a change, tenants reading internal DNS answers from refusals, a blocked threadpool, disguised loopback hosts passing, edits blocked by an unchanged target. KEEP: the loop-1 code is in `git stash` entry "story-5.1 loop-1 code (pre-replan)" (backup diff also at the session scratchpad); restore it with `git stash pop` and amend it rather than rewriting. It was correct on everything not listed here: the migration, `monitorStateOf`, events, the slice files, the domain's problem collection, the 9.11 registry entries and the test structure. Re-apply the migration with `pnpm run db:migrate`; it was rolled back locally.

## Review Triage Log

Review pass 1 (loop 1). B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| B1 | `monitor.updated` fires on a no-op | medium | DOMAIN.md:1381 says `*.updated` announces a change, never an attempt; the frozen intent says emit on an empty patch. intent_gap |
| B8 | Frozen "every refusal is `Invalid input. <field>:` on both surfaces" is broken on REST | low | REST answers schema-stated rules with Fastify's validation error, field in `subErrors`, as every existing slice does; the story AC asks only for "a 400 naming the field". Frozen wording too strong. intent_gap |
| E13 | `localhost` refused even when 127.0.0.0/8 is allowed | medium | Story AC: "the same target is accepted when its address falls inside a CIDR range listed in the allowed list"; frozen intent refuses localhost names before the list is consulted. intent_gap |
| B2 | Refusal echoes the resolved address of an internal name | medium | `target-safety.ts` check(): message includes `(${address})` from the lookup; a tenant can map internal DNS, which 6.5 exists to prevent. bad_spec |
| B3 | Timed-out getaddrinfo keeps a libuv thread | medium | `dns.lookup` cannot be cancelled; the race returns but the threadpool thread stays busy until the OS resolver gives up. bad_spec |
| B7 | Disguised IPv4 (`127.1`, `2130706433`) in tcp/ssl hosts | medium | `splitHostPort` accepts them via `HOSTNAME`; refused only if getaddrinfo applies inet_aton, and accepted on a failed lookup (and always under a c-ares resolver, B3's fix). bad_spec |
| E5 | Re-sending the stored target re-runs the DNS check | medium | `patch.target !== undefined` triggers the check; a full-form client whose stored host now resolves privately cannot save any edit, even a disable. bad_spec |
| B4/E9 | URL target stored differently from what was validated | low | Verified: `new URL(' https://203.0.113.10/a\tb ').href` is `https://203.0.113.10/ab`; raw string is stored. bad_spec |
| B15/E8 | http/keyword accept port 0 | low | Verified: `new URL('http://x:0/').port === '0'`; tcp refuses it. bad_spec |
| E6/E10 | Host label validation (trailing dots, empty labels) | low | `cleanHost` strips one dot; `localhost..:80` skips the name check and is accepted on a failed lookup. bad_spec |
| B5/E7 | 6to4, `::ffff:0:0:0/96`, 240/4, fec0::/10 unclassified and undocumented | low | `classifyAddress` returns null for them; ARCHITECTURE 6.5 names only NAT64/CGNAT. Document. bad_spec |
| B6 | ARCHITECTURE 6.5 first bullet omits broadcast and `::/96` | low | Code blocks both; doc lists five classes. bad_spec |
| E4 | Malformed target plus another problem names only target | low | Phase-1 `assertTargetAllowed` throws before `applyUpdate` collects all problems. bad_spec (order) |
| B13 | `AllowedCidr` and `AllowedRange` duplicated | low | Identical interfaces in `allowed-cidrs.ts` and `target-safety.ts`. bad_spec |
| E12 | `setMonitorCheckState` silently matches zero rows | low | No `returning`/row-count assert in `fixtures.ts`. bad_spec |
| V1 | Malformed `id` / `serviceId` never sent over GraphQL | medium | No `not-a-uuid` in monitoring tests; sibling suites cover it. bad_spec |
| V2 | Handlers never run with allowed CIDRs set | medium | Only `target-safety.spec.ts` passes ranges; a handler dropping `allowedRanges` passes every test. bad_spec |
| V4 | `enabled: true` on an enabled monitor untested | medium | Every `enabled: true` patch follows a disable; a loosened reset condition passes. bad_spec |
| V5 | Concurrency test is single-shot | medium | Without the lock it passes whenever inject serializes; incident-concurrency uses a staged lock. bad_spec |
| V6 | Non-default create values never asserted | medium | Creates assert defaults only; `enabled: false` never created. bad_spec |
| V7 | One-field timeout patch untested; comment wrong | medium | Test sends both fields; a one-field conflict would hit the DB CHECK as a masked 500 if the merge regressed. bad_spec |
| B9 | REST refusal assertions match loosely | low | `assert.match(body, /keyword/)` can match unrelated text; `refusedUpdate` asserts no field on REST. bad_spec |
| B10 | No GraphQL explicit-null tests | medium | AGENTS names "optional but never null" as the handler check's reason; no monitor test sends null. bad_spec |
| V3 | No boot test for an invalid `MONITOR_ALLOWED_CIDRS` | low | Parser unit-tested; boot call is one line at module load. defer (filed disposition) |
| E1/E2/B11/E3 | REST strips unknown keys (`type` on PATCH, misspelled config keys) and coerces `enabled: null` to false | medium | Fastify defaults (`removeAdditional`, `coerceTypes`) in `build-app.ts:36-40`, which only adds `keywords`; every slice behaves this way. defer (pre-existing, global) |
| E11 | U+0000 in a string gives a masked 500 | medium (unverified) | Postgres rejects NUL in text/jsonb; pre-existing for every slice's strings. defer |
| B12 | sprint-status at `in-progress`, spec at `in-review` | false | Step 5 of the workflow moves the story to `review`; nothing is stale yet. |
| B14 | `warnDays` CHECK can raise 22003 on raw SQL | low | Reachable only by raw SQL; schema caps at 365. rejected (low, unlikely) |

Review pass 2 (after loop 1). B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| E1/B1 | tcp/ssl host with `@ / ? # \` accepted, stored as typed | medium | Probed: `parseTarget('tcp', '10.0.0.1@203.0.113.5:80')` returns host 203.0.113.5; the stored string is not the validated one. patch |
| E3 | Allowed entry `::ffff:10.0.0.0/8` allows every blocked address | high | Probed: with that list, 127.0.0.1, 192.168.1.1 and ::1 are all accepted; `parseAllowedCidrs` accepts host bits beyond the prefix. patch |
| V1 | Production `defaultLookup` (Resolver) never runs in a test | medium | Every hostname test injects `lookup`; flipping `&&` to `\|\|` in the both-rejected check passes all tests. patch |
| E2 | Bracketed IPv6 with a zone id accepted | low | Probed: `[2001:db8::1%eth0]:80` parses with the zone kept. Direct fix. patch |
| B6 | Nothing enforces "v1 has no monitor delete" | medium | `watchdog_app` keeps DELETE via default privileges; `services` got a revoke for the same rule; AGENTS: omitting methods is not enforcement. patch (migration is unmerged; roll back and re-apply locally) |
| B7 | `failing -> null`, `failing -> degraded` and payload fields untested | medium | Derived-state tests start from `degraded` only; the AC names `degraded` or `failing`. patch |
| B8 | `monitor.updated` not proven for config or enabled edits; `updated_at` unasserted | medium | The edit test's `config: {}` matches the stored `{}`; no `enabled` change asserts the event. patch |
| B13 | `sameConfig` compares two named keys | low | A later config key would make a config-only edit a silent no-op answering 200. Direct fix (key-generic compare). patch |
| B2 | IDN host accepted for http, refused for tcp | low | `LABEL` tests the raw name while URL targets are punycoded. Direct fix (test the normalised name). patch |
| B4/E6 | ARCHITECTURE 6.5 omissions list incomplete; resolver blind spots undocumented | low | Teredo, `64:ff9b:1::/48`, 192.0.0.0/24, 198.18.0.0/15 classify null; `Resolver` skips `/etc/hosts` and search domains. Doc fix. patch |
| B5 | DOMAIN no-op paragraph does not name `UpdateMonitorCommand` | low | DOMAIN.md:1381 names two commands. Doc fix. patch |
| B9/V-other | Stale comment (V7), half-tested test name, stale header in `target-safety.ts` | low | Comments contradict the code beside them. patch |
| V2 | `MONITOR_ALLOWED_CIDRS` env-to-config hop untested | low | Tests assign `config.monitor.allowedCidrs` directly. defer, with loop-1's V3, as one spawned-process boot test |
| E4 | Target changed between the unlocked and locked reads is written unchecked | false | The only way `patch.target` skips the check is equalling the target stored at phase one, which itself passed the check when stored. |
| E5 | NUL in name/keyword gives a masked 500 | carried | Same as loop-1 E11, already deferred. |
| B3/V-other | Spec Design Notes and Change Log stale | rejected | Fix edits this build's spec. |
| B10 | `assertRestNames` message fallback is loose | low | Needed for `required` errors whose path is the parent; test-only. rejected (low) |
| B11 | Create resolves DNS before checking the service exists | low | Costs a wasted lookup on a refused create. rejected (low; fix adds a read) |
| B12 | No behavioural unauthenticated test | false | The 9.11 registry sends both mutations without a cookie and asserts `UNAUTHENTICATED`; REST 401 is the shared route path, checked statically. |
| B14 | `allowedList` rebuilt per call; two `monitorConfigSchema` names | low | Cosmetic. rejected |

## Design Notes

Deviation from the story's Files: `dtos/` (presenter, response DTO, `Monitor` SDL type) moves to 5.2. Both mutations return an id like every other create/update, so 5.1 would ship an unused presenter; the parity contract compares request shapes only.

`target-safety.spec.ts` stubs the lookup (slow, failing, mixed public/blocked answers); the handler uses `dns.promises.lookup` with `all: true`.

Rules from review loop 1 (outside the frozen intent):
- Resolve with `dns.promises.Resolver` (`timeout`, `tries: 1`, `resolve4` + `resolve6`, `cancel()` on the 5 s limit), never `dns.lookup`: getaddrinfo cannot be cancelled and holds a libuv threadpool thread after the race gives up.
- Host parsing for every type goes through one function: IPv4 written in any WHATWG form (`127.1`, `2130706433`, `0x7f.1`) is normalised to its dotted quad, as the URL path already does; labels are 1–63 characters, no empty labels, at most one trailing dot. A target containing whitespace or control characters is refused, so the stored string is the validated one. URL targets refuse an explicit port 0.
- The DNS courtesy check runs only when the patch's `target` differs from the stored one, after `applyUpdate` has validated the merged monitor, so a refusal names every problem and a full-form save is not blocked by an unchanged target.
- One `AllowedCidr` type, exported from `src/config/allowed-cidrs.ts` and imported by `target-safety.ts`.
- ARCHITECTURE 6.5's first bullet lists every class the code blocks, broadcast and `::/96` included; the omissions line names NAT64, CGNAT, 6to4 (`2002::/16`), `::ffff:0:0:0/96`, 240.0.0.0/4 and fec0::/10.
- `setMonitorCheckState` asserts it updated exactly one row.

Update runs in two phases: if `target` changes, read the type and run the DNS courtesy check outside any lock; then one transaction locks, merges, validates the merged monitor, computes before/after with `monitorStateOf`, and writes.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `pnpm run test:integration` -- pass (rerun failures 2–3× per AGENTS clock-skew rule; report all)
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
