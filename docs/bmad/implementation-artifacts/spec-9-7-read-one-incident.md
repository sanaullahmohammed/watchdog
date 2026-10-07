---
title: 'Story 9.7 — Read one incident with its affected services'
type: 'feature'
created: '2026-10-07'
status: 'done'
baseline_commit: '2931bac2409562e812de36b058e2656fc9bafacc'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A client can edit an incident's affected services, but no read returns them. `updateIncident` replaces the whole list, so a client that edits from what it can read silently drops services (audit F-03, part 2).

**Approach:** Add one read slice to the incident module, `GET /api/v1/incidents/:id` and `Query.incident(id: ID!)`, sharing one presenter. It answers a new admin detail shape: the `Incident` fields (`id, title, status, impact, source, startedAt, resolvedAt`) plus `affectedServices: [{ serviceId, impact }]`, ordered by `serviceId`. The `Incident` type used by the list stays unchanged, because the list does not load affected services.

## Boundaries & Constraints

**Always:**
- The read goes through `withTenantTransaction` and the existing `incidentRepository.findById`. Another org's incident is invisible under RLS, so it is a 404 `NotFoundException`, like an unknown id.
- Drafts are returned: this is the admin surface.
- The handler calls `assertUuid(id, 'id')` before any SQL.
- The handler returns the entity. The route and the resolver apply the same presenter from `dtos/`.
- `affectedServices` items have exactly the shape `updateIncident` accepts (`AffectedServiceInput`), so the response feeds back without reshaping.

**Never:**
- No change to `Incident`, `list-incidents`, `update-incident`, the public `PublicStatus*` types, migrations, or `docs/genesis/*`.
- No service names or other joins in `affectedServices`.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected (REST and GraphQL alike) |
|---|---|---|
| Two services | incident naming two services with different impacts | headline fields and both `{ serviceId, impact }`, ordered by `serviceId` |
| No services | incident with none | `affectedServices: []` |
| Round trip | the REST response sent whole as the `PATCH` body; over GraphQL, its `title`, `impact` and `affectedServices` as the input | 200, no `incident.updated` for that incident, and a re-read equals the first read |
| Draft | a `draft` incident | returned with `status: draft` |
| Another org's incident | its id | REST 404. GraphQL: `data` null, `errors[0].message` matches `/not found/`, HTTP 404 |
| Unknown id | well-formed unused uuid | 404, as above |
| Malformed id | `not-a-uuid` | REST 400. GraphQL: message starts `Invalid input.` and names `id`, HTTP 400 |
| No session | no cookie | REST 401; GraphQL `UNAUTHENTICATED` |

</frozen-after-approval>

## Code Map

- `src/modules/service/queries/get-service-group/` -- the template from 9.6: handler, route, resolver, `.graphql-schema.ts`, and `.schema.ts` exporting only `{ id: uuid }`, which the route imports as `params`.
- `src/modules/incident/database/incident.repository.ts:196-230` -- `findById` already loads `affectedServices`, `order by service_id`, with no draft filter. Reuse it as is.
- `src/modules/incident/domain/incident.domain.ts:20-34` -- `IncidentEntity` already carries `affectedServices`.
- `src/modules/incident/dtos/`
  - `incident.response.dto.ts`: `incidentResponseDtoSchema`.
  - `incident.present.ts`: `toIncidentResponse`.
  - `incident.graphql-schema.ts`: `type Incident`.
  - The detail shape extends these; do not duplicate the headline mapping.
- `src/modules/incident/queries/get-incident-timeline/` -- sibling get-one: route, resolver auth, `NotFoundException('Incident <id> not found')`.
- `src/modules/incident/index.ts:14` -- `incidentActionCreator`. Types in use: `create`, `update`, `transition`, `timeline`, `list`, plus post-update's. `'get'` is free. The bus silently replaces a reused type.
- `src/modules/incident/commands/update-incident/`
  - The handler emits only when `title`, `impact` or `startedAt` changed, or the set of `serviceId:impact` pairs differs (order-insensitive, lines 74-88).
  - The REST route spreads the body and then sets `id` from params. Extra fields pass validation, and `updateDetails` writes only `title` and `impact`.
  - GraphQL's `UpdateIncidentPayload` refuses unknown fields, so only the three editable fields can be sent.
- `AffectedServiceInput` -- in `commands/create-incident/create-incident.graphql-schema.ts:2`. `IncidentImpact` and `IncidentStatus` are in `src/shared/domain/status-ladders.graphql-schema.ts`.
- `src/modules/incident/incident-lifecycle.integration.test.ts:32-79` -- local helpers `declare`, `patch`, `createService`, `capturing`; copy the pattern, they are not exported. `capturing` records only the event type. `app.eventBus.on(type, handler)` hands the handler the event, and `incident.updated`'s payload is `{ id, orgId }` (`src/shared/events/incident.events.ts`), so the new test records `event.payload.id`.
- `src/modules/incident/database/incident.repository.ts:155-164` -- impacts are inserted in request order. The primary key is `(incident_id, service_id)`, so an index scan may return `service_id` order even without `order by`.
- `src/modules/incident/incident-reads.integration.test.ts:71` -- a draft is inserted by SQL inside `withTenantTransaction`. Nothing yet creates drafts through a command.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/incident/dtos/`
  - `incident.response.dto.ts`: `incidentDetailResponseDtoSchema`, the incident fields plus `affectedServices: Array<{ serviceId: uuid, impact }>`.
  - `incident.present.ts`: `toIncidentDetailResponse(entity)`, built on `toIncidentResponse`.
  - `incident.graphql-schema.ts`: `type AffectedService { serviceId: ID!, impact: IncidentImpact! }` and `type IncidentDetail { id: ID!, title: String!, status: IncidentStatus!, impact: IncidentImpact!, source: IncidentSource!, startedAt: String!, resolvedAt: String, affectedServices: [AffectedService!]! }`.
- [x] `src/modules/incident/queries/get-incident/`
  - Handler `incidentActionCreator('get')`, registered on `queryBus`: `assertUuid`, then `findById`, else `NotFoundException`.
  - Route `GET /v1/incidents/:id` with the 200 response `incidentDetailResponseDtoSchema`.
  - Resolver.
  - `get-incident.graphql-schema.ts`: `type Query { incident(id: ID!): IncidentDetail! }`. Non-null, so a refusal gives `data: null` and mercurius takes the HTTP status from the error.
  - `get-incident.schema.ts`.
- [x] `src/modules/incident/incident-detail-read.integration.test.ts`
  - Covers every matrix row on both surfaces.
  - REST and GraphQL bodies compared deep-equal for the two-service incident and the draft.
  - The incident names the larger `serviceId` first in its `affectedServices` payload, and the expected order is hard-coded, so a missing `order by` fails at least whenever the planner scans the heap.
  - The round trip records `incident.updated` payload ids and asserts none is this incident's. A positive control (changing one impact) asserts one is.
  - The REST round trip sends the whole response, so it also pins that `PATCH` tolerates the read-only fields (`id`, `status`, `source`, `startedAt`, `resolvedAt`) and writes none of them.
  - The cross-org row reads org A's incident with org B's cookie.
  - The timeline and list reads still answer in the same file.
  - An `after()` cleans up.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when sent over both surfaces, then the outcome matches the matrix.
- Given the parity contract, when it runs, then `get-incident` passes the field comparison against `incident(id: ID!)`, and `authenticated-surface.spec.ts` accepts both new operations.
- Given `pnpm run check`, when run, then dependency-cruiser reports no handler importing `dtos/`.

## Design Notes

- `IncidentDetail` is a separate type, not new fields on `Incident`. The list reads incidents without their impacts, so an `Incident.affectedServices` would answer `[]` there, which is a lie.
- `ARCHITECTURE.md:46` lists the incident module's "key" queries without `GetIncidentQuery`. 9.6 likewise added its group reads without editing genesis, so this story leaves it.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass, including the parity and authenticated-surface specs.
- `pnpm run test:integration`, twice -- expected: all pass. Re-run a timeline-order failure; it is this machine's clock (deferred-work.md).
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op if `acme-demo` exists.

## Implementation Notes

- Review patches applied: the read runs under `repeatable read, read only`, with a test that commits an edit inside the read and fails without it (checked by removing the option); a `PATCH` sending different read-only fields leaves them unchanged; a resolved incident reads alike on both surfaces; the no-session GraphQL row asserts HTTP 200; one `impactSchema` in `incident.response.dto.ts`.
- This TypeBox has no `Type.Composite`, so the detail schema spreads `incidentResponseDtoSchema.properties`.
- Verified: check clean; unit 111/111 with and without `.env` (same count as the base); integration 274/274 twice; auth schema in sync; `db:seed` a no-op (`acme-demo` exists).

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The detail read can pair one version's title and impact with another's services (edge, gap, blind) | medium | `findById` issues two statements; the handler used the default READ COMMITTED, so an `updateIncident` committing between them is seen by the second only | patch |
| 2 | The REST round trip resends current values, so it cannot show `PATCH` writes no read-only field (edge, blind) | medium | The spec says the test pins it; a `updateDetails` that wrote `status` would still pass | patch |
| 3 | No read of a non-null `resolvedAt` on either surface (blind) | low | Every incident in the test is unresolved | patch |
| 4 | No-session GraphQL row does not assert the HTTP status (blind) | low | The other GraphQL rows do, as 9.6's tests do | patch |
| 5 | `impactSchema` declared once but the headline `impact` still inlines a copy (blind) | low | `incident.response.dto.ts` | patch |
| 6 | Two clients editing from separate reads still drop each other's services; the detail carries no `updatedAt` or version (blind) | medium | `PATCH` replaces the whole list with no precondition; pre-existing in the edit, not caused by the read | defer |
| 7 | SDL `IncidentDetail` repeats `Incident`'s fields by hand and can drift from REST (blind) | low | The surfaces are independently authored by design (epic context); the REST/GraphQL deep-equal test fails on a field only one side has | reject |
| 8 | `AffectedService` and `AffectedServiceInput` are copies (blind) | low | Same design; the GraphQL round-trip test fails if the input gains a required field | reject |
| 9 | The positive control mutates the shared incident, so tests depend on order (blind) | low | `node:test` runs a file's tests in order; reordering is unlikely, and the fix adds fixtures | reject |
| 10 | Sprint status says in-progress while the spec says in-review; `deferred-work.md` ticked but unchanged; `ARCHITECTURE.md:46` drift unrecorded (blind) | false | Step 5 sets review; the defer entry is appended now; ARCHITECTURE lists "key" queries, as 9.6 left it | reject |
| 11 | The diff moves 9.6 to done and leaves out this spec (blind) | false | The owner asked for 9.6's bookkeeping here; the spec is withheld from reviewers by design and committed with the code | reject |
