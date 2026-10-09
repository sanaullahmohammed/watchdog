---
title: "Story 5.2: List a service's monitors"
type: 'feature'
created: '2026-10-09'
status: 'done'
baseline_commit: '641cd20ebcd76dc4aad8361b8ff86ca5f68c9fd6'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-5-context.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A client can create and edit monitors (5.1) but cannot read them back, so it cannot reopen what it configured (FR27; ARCHITECTURE section 2's 2026-10-09 decision names `ListMonitorsQuery` as that read). Separately, nothing fails when an id-taking GraphQL `Query` field ships without a malformed-id case (deferred-work, Epic 9 retro item 1c).

**Approach:** One query slice `ListMonitorsQuery` over REST and GraphQL, the monitor presenter, response DTO and `Monitor` SDL type that 5.1 left to this story, and an id-taking `Query` field registry beside 9.11's mutation registry, which closes the deferred-work entry.

## Boundaries & Constraints

**Always:**
- Story 5.2's five acceptance criteria (epics.md) are the contract.
- REST `GET /v1/services/:serviceId/monitors` (served at `/api/v1/...`); GraphQL `monitors(serviceId: ID!): [Monitor!]!`. Both answer the same array through one presenter.
- Each item: `id`, `serviceId`, `type`, `name`, `target`, `intervalSeconds`, `timeoutSeconds`, `failureThreshold`, `enabled`, `config`, `consecutiveFailures`, `lastCheckedAt` (ISO string or null). `config` always carries both keys, `keyword` and `warnDays`, null when absent (a stored `{}` becomes both null), so REST and GraphQL bodies are identical. SDL: `type: String!` as in 5.1, no enum; `lastCheckedAt: String`; `config: MonitorConfig!`.
- Order: `name asc, id asc`.
- A service that is unknown, or in another organization, answers 200 with `[]`: the story says "none appear", and 5.2 reads only `monitors`: the first cross-module table read waits for 5.8, which adds the foreign-table-read allowlist test (epics.md, Epic 3 retro item 23). Monitors of an archived service are listed.
- A malformed `serviceId` is 400 on both surfaces: REST by its params schema, GraphQL by the handler's `assertUuid(serviceId, 'serviceId')` before any SQL.
- Registry: the guard enumerates every `Query` field with an argument whose type, unwrapped through non-null and list, is `ID`, also inside input objects, and fails when that set and the registry disagree in either direction. Each entry sends a malformed id with a session and asserts 400, `data: null`, and a message matching `^Invalid input\. (?:.*; )?<arg>: `. `publicStatusPage(orgSlug: ID!)` takes a slug and answers the uniform miss by design (AGENTS), never 400: its entry states that reason and asserts a malformed slug gets the same answer as an unknown well-formed one.

**Never:** a new migration; `failureEpisode`, `orgId`, derived state or timestamps other than `lastCheckedAt` in the response; check results (`GetMonitorResultsQuery` is deferred); reading `services` from monitoring; importing another module; a JSON scalar for `config`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed monitors | service with http, keyword, ssl_expiry, tcp; one disabled; one with failures 2 and a check time | all four, full config, counters, ordered name then id | N/A |
| Name tie | two monitors with the same name | ordered by id, same on every request | N/A |
| No monitors | own service, none configured | `[]` | N/A |
| Foreign service | service id of another org with monitors | `[]` | N/A |
| Malformed id | `not-a-uuid` | 400 on REST and GraphQL | GraphQL names `serviceId` |
| No session | either surface | 401 / `UNAUTHENTICATED` | N/A |

</frozen-after-approval>

## Code Map

- `src/modules/incident/queries/get-incident-timeline/*` -- template for handler (`assertUuid`, `withTenantTransaction`, `queryBus.register`), route (params, `Type.Array(dto)`, `UnauthorizedException`), resolver (`ErrorWithProps UNAUTHENTICATED`); unlike it, do not look up the parent
- `src/modules/service/queries/get-service-group/get-service-group.schema.ts` -- one-object params schema; name must match the SDL arg (`serviceId`)
- `src/modules/service/dtos/service.{present,response.dto,graphql-schema}.ts` -- dtos naming and shape; monitoring uses `monitor.present.ts`, `monitor.response.dto.ts`, `monitor.graphql-schema.ts`
- `src/modules/monitoring/dtos/monitor-config.graphql-schema.ts` -- input type; add the output `MonitorConfig` type beside `Monitor`
- `src/modules/monitoring/database/monitor.repository.ts` -- add `listByService(tx, serviceId)`; ordering comment as in `service.repository.ts:42`
- `src/modules/monitoring/index.ts` -- `monitoringActionCreator('monitor')` for the query
- `src/shared/api/graphql-mutations.integration.test.ts` -- structure to mirror: `buildApp`, `signUpWithOrg`, `getQueryType()` diff with `{ missing, stale }`
- `src/shared/api/contract/api-surface-parity.spec.ts` -- scalar-only args are compared with the `.schema.ts` params object
- `src/shared/testing/{fixtures,graphql,tenant}.ts` -- `createService`, `createMonitor(app, cookie, serviceId, overrides)`, `setMonitorCheckState`, `gql`, `gqlData`, `signUpWithOrg`; any new helper goes here

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/monitoring/database/monitor.repository.ts` -- `listByService`, `order by name asc, id asc`
- [x] `src/modules/monitoring/dtos/{monitor.response.dto.ts,monitor.present.ts,monitor.graphql-schema.ts}` -- TypeBox response, `toMonitorResponse(entity)`, SDL `Monitor` and `MonitorConfig`
- [x] `src/modules/monitoring/queries/list-monitors/list-monitors.{handler,route,resolver,schema,graphql-schema}.ts` -- the slice
- [x] `src/shared/api/graphql-id-queries.integration.test.ts` -- the id-taking `Query` registry: `incident`, `incidentTimeline`, `maintenanceWindow`, `service`, `serviceGroup`, `monitors`, and exempt `publicStatusPage`
- [x] `src/modules/monitoring/read-monitors.integration.test.ts` -- every AC and matrix row; REST and GraphQL bodies `deepEqual` for the same list; a second request returns the same order
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- remove the id-taking `Query` field registry entry

**Acceptance Criteria:** story 5.2's five criteria in epics.md, each proven by the named tests.

## Implementation Notes

- Implemented by a Sonnet subagent from this spec; the main session read the whole diff against every task, AC and matrix row.
- Review pass 1 patches (same subagent, re-engaged): ordering tests create out of name order and force a creation order unlike id order; the registry also counts arguments named `id` / `*Id`; exempt entries carry their own query and assert the `Status page not found` miss; the response DTO derives `type` from `MONITOR_TYPES` and inlines its null unions.
- Verification after pass 1 (main session, 2026-10-09): check clean (11 pre-existing warnings, none in touched files); unit 201/201, and 201/201 with `.env` moved aside; integration 426/426 first run, no reruns; e2e 3/3 scenarios; auth:schema:check in sync.

## Spec Change Log

## Review Triage Log

Review pass 1. B = blind, E = edge-case, V = verification-gap.

| # | Finding | Verdict | Evidence / route |
|---|---|---|---|
| V1/B1 | Order is pinned only by tests a broken order passes | medium | "lists every monitor" creates in name order, so heap order equals the expected order; the tie test's 3 random v4 ids are already id-sorted 1 run in 6. patch |
| E1/E5/B2 | `urn:uuid:<uuid>` passes `assertUuid` and the params schema, then Postgres gives a masked 500 | medium | Same `format: 'uuid'` mechanism as the 9.1 deferred entry, which lists every other id read. defer (pre-existing class; new entry names these two reads) |
| E4/B4 | Guard misses an id-taking field typed `String` | low | `unwrapsToId` checks the named type only; AC4 says a new id-taking field must fail the build. patch (also match names `id` / `*Id`) |
| E3/B3a | Exempt loop hard-codes `orgSlug` and `overallStatus` | low | `graphql-id-queries.integration.test.ts` exempt loop builds one query for every name. patch |
| B3b | `Entry` cannot express an id inside an input object | false | A variable can sit inside an input literal: `query ($id: ID!) { f(filter: { serviceId: $id }) { id } }`, so the entry shape and `{ id }` variables suffice. |
| B5 | Exempt case passes if both answers are the same unrelated error | low | It asserts only `!== 400` and equality. patch (assert `data: null` and `Status page not found`) |
| B7 | DTO `nullable` helper fits String only; `type` not derived from `MONITOR_TYPES` | low | `monitor.response.dto.ts`; `service.response.dto.ts` derives its enum. patch |
| B6 | GraphQL side of archived and no-session tests incomplete; REST malformed body not checked for `serviceId` | low | Same handler and presenter on both surfaces; AC3 asks for 400 only; REST/GraphQL equality is proven in the mixed test. rejected (low) |
| B8 | Output `MonitorConfig` has no descriptions; nothing ties DTO field names to SDL `Monitor` | low | Response parity rests on the shared presenter project-wide; the mixed test compares all selected fields. rejected (low, pre-existing pattern) |
| B9 | Patch omits the spec; sprint-status 5.2 `in-progress` while spec is `in-review`; 5.1 flipped to done here | false | The spec is the claims file by design; step 5 moves 5.2 to review; the owner asked for 5.1 done on this branch. |
| E2/B10 | List has no bound | low | No per-service cap exists in DOMAIN; every other list is unbounded too. rejected (low, unlikely) |

## Design Notes

`[]` for an unknown service departs from the parent-lookup precedent (`get-incident-timeline` answers 404; 5.1's create refuses through the foreign key, a 400). A 404 here would need a read of `services`, which waits for 5.8's allowlist. The story's "none appear" allows `[]`.

The registry's malformed-id message match also proves the operation text is right: a GraphQL validation error answers 400 too, but never with `Invalid input. <arg>:`.

## Verification

**Commands:**
- `pnpm run check` -- clean
- `pnpm run test`, and again with `.env` moved aside -- pass
- `pnpm run test:integration` -- pass (rerun failures 2–3× per AGENTS clock-skew rule; report all)
- `pnpm run test:e2e`, `pnpm run auth:schema:check` -- pass
