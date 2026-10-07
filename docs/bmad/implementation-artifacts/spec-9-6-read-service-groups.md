---
title: 'Story 9.6 — Read service groups'
type: 'feature'
created: '2026-10-07'
status: 'done'
baseline_commit: '9fbc09cef28b972e86ace9fae9781aad172930fc'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A client can create, edit and delete service groups but cannot read them back, over either surface. A client that loses its local state cannot show or edit a group (audit F-03, part 1).

**Approach:** Add two read slices to the service module, each over REST and GraphQL, sharing one presenter:
- list: `GET /api/v1/service-groups`, `Query.serviceGroups`;
- get one: `GET /api/v1/service-groups/:id`, `Query.serviceGroup(id)`.

A group reads as `{ id, name, slug, displayOrder }`: the fields a client can edit, matching the admin `Service` type, which exposes neither `orgId` nor timestamps. The list is unbounded, since an organization has tens of groups. Pagination is decided in Epic 8 before any list becomes an external contract (audit F-14).

## Boundaries & Constraints

**Always:**
- The list orders by `display_order`, then `name`, then `id`, so equal rows never swap between requests.
- Every read goes through `withTenantTransaction`. Another organization's group is invisible under RLS, so reading it answers 404 `NotFoundException`, the same answer as an id that never existed.
- The get-one handler calls `assertUuid(id, 'id')` first, so a malformed id over GraphQL is a 400, not a masked 500.
- Handlers return entities. The route and the resolver each apply the one presenter in `dtos/`.

**Never:**
- No change to existing service reads: `list-services` ordering is Story 9.8, and `service(id)`'s masked 500 is deferred work.
- No change to the public `PublicStatus*` types, the admin `Service` type, or any migration.
- No pagination.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected (REST and GraphQL alike) |
|---|---|---|
| Ordered list | groups created in reverse of the expected order, including two with equal `display_order` and equal `name` (different slugs) | ordered by display order, then name, then id |
| Empty | an organization with no groups | `[]` |
| Own group | its id | `{ id, name, slug, displayOrder }` |
| Another org's group | its id | REST 404. GraphQL: `data` null and `errors[0].message` matching `/not found/` (mercurius sets HTTP 404 from the error), never an empty result |
| Unknown id | a well-formed uuid nobody holds | 404, same as above |
| Malformed id | `not-a-uuid` | REST 400 (params schema). GraphQL: `errors[0].message` starts `Invalid input.` and names `id`, not `Internal Server Error` |
| No session | either read without a cookie | 401 over REST; `UNAUTHENTICATED` over GraphQL |

</frozen-after-approval>

## Code Map

- `src/modules/service/queries/get-service/` -- the get-one pattern.
  - Handler with `serviceActionCreator(...)`, `withTenantTransaction`, `NotFoundException`.
  - Action types must be new: `'get'` and `'list'` belong to the service reads, and `queryBus.register` is a `Map.set` (`src/shared/cqrs/command-bus.ts:13-24`), so a reused type silently replaces a handler. The group commands use `'group.create'` / `'group.update'` / `'group.delete'`.
  - Route `GET /v1/services/:id` with inline uuid params.
  - Resolver calling `resolveOrganizationContext(ctx.reply.request.headers)`, then `ErrorWithProps('Authentication required', { code: 'UNAUTHENTICATED' })`.
- `src/modules/service/queries/list-services/` -- the list pattern.
  - Its response is declared as `Type.Array(serviceResponseDtoSchema)`.
- `src/modules/service/dtos/` -- `service.present.ts` (`toServiceResponse`), `service.response.dto.ts`, `service.graphql-schema.ts`. No `ServiceGroup` type exists anywhere yet.
- `src/modules/service/database/service-group.repository.ts` and `.repository.port.ts` -- only `insert`, `update`, `remove` today. Rows map through `service-group.mapper.ts` to `ServiceGroupEntity` (`domain/service-group.types.ts`).
- `src/modules/service/commands/delete-service-group/` -- already uses `assertUuid` and the message `Service group ${id} not found`.
- `src/shared/api/contract/api-surface-parity.spec.ts`
  - Pairs route and resolver by slice directory (:171).
  - Compares field names only where a slice has both `.schema.ts` and `.graphql-schema.ts`, and the schema exports exactly one TypeBox object (:188-213).
  - An argument-less list cannot be compared by field names: a `.schema.ts` there fails with "declares no operation argument".
  - The get-one slice gets `get-service-group.schema.ts`, exporting only `{ id: uuid }`, which the route imports as `params`. This is the pattern of `get-public-status-page.schema.ts`.
- `src/shared/api/contract/authenticated-surface.spec.ts` -- each new route and resolver operation must call `resolveOrganizationContext` in its own body.
- `src/modules/service/list-services.integration.test.ts` -- the test template: `signUpWithOrg`, `TEST_ORIGIN`, `app.inject`, and an `after()` that deletes orgs and users and closes.
- `src/server/gql.ts` loads every `*graphql-schema*` file. Declare `type ServiceGroup` once, in `dtos/`.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/service/database/service-group.repository.port.ts` + `.repository.ts` -- add `findById(tx, id)`, returning the entity or `undefined`, and `list(tx)`, ordered `display_order asc, name asc, id asc`.
- [x] `src/modules/service/dtos/`
  - `service-group.response.dto.ts`: a TypeBox object `{ id: uuid string, name, slug, displayOrder: integer }`.
  - `service-group.present.ts`: `toServiceGroupResponse(entity)`.
  - `service-group.graphql-schema.ts`: `type ServiceGroup { id: ID!, name: String!, slug: String!, displayOrder: Int! }`.
- [x] `src/modules/service/queries/list-service-groups/` -- handler (`serviceActionCreator('group.list')`), route and resolver as in list-services; `list-service-groups.graphql-schema.ts` declares `type Query { serviceGroups: [ServiceGroup!]! }`. No `.schema.ts`.
- [x] `src/modules/service/queries/get-service-group/` -- handler (`serviceActionCreator('group.get')`; `assertUuid`, then `findById`, else `NotFoundException('Service group <id> not found')`), route, resolver, `get-service-group.graphql-schema.ts` (`type Query { serviceGroup(id: ID!): ServiceGroup! }`), and `.schema.ts`.
- [x] `src/modules/service/service-group-reads.integration.test.ts`
  - Covers every matrix row over both surfaces; REST and GraphQL bodies compared equal for the list and for one group.
  - The no-groups case uses its own organization.
  - The cross-org case reads org A's group with org B's cookie.
  - GraphQL error rows assert `data` null and the message, never HTTP 200: mercurius takes the status from the single error (`node_modules/mercurius/lib/errors.js:59-63`).
  - The id tiebreak: two groups with equal `display_order` and `name` are created so that the first inserted has the larger id (recreate until that holds), and the expected order is hard-coded, not computed in JS: the database collation decides name order. Without this, a missing `id` sort key passes about half the time.
  - Existing service reads still answer after the new handlers register: list services and get one service in the same file.
  - An `after()` cleans up.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`, in the existing format.

**Acceptance Criteria:**
- Given any matrix row, when sent over both surfaces, then the outcome matches the matrix.
- Given the parity contract, when it runs, then `get-service-group` passes the field comparison against `serviceGroup(id: ID!)`, and `list-service-groups` passes the route-to-resolver coverage check (`api-surface-parity.spec.ts:171`), the only comparison possible for an operation with no arguments.
- Given `pnpm run check`, when run, then dependency-cruiser reports no handler importing `dtos/`.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | GraphQL error rows do not assert `data` null, the no-session message, or the HTTP status (edge, blind) | low | Spec task says error rows assert `data` null and the message; the no-session loop checks only `extensions.code` | patch |
| 2 | No test reads a group back after an edit or a delete (blind) | low | The story's purpose is reopening what a client edits; nothing joins update/remove to the reads | patch |
| 3 | `createGroup` is typed as a full group but the create route answers only `{ id }` (gap, other) | low | `create-service-group.route.ts` sends `{ id }` | patch |
| 4 | `update`'s empty-patch branch repeats `findById`'s SQL (blind) | low | `service-group.repository.ts` | patch |
| 5 | The presenter comment says "fields a client can edit" but includes `id` (blind) | low | `service-group.present.ts` | patch |
| 6 | `urn:uuid:` ids pass `assertUuid` and the params schema on the new get-one, a masked 500 (edge) | medium | `ajv-formats` uuid regex allows the prefix; Postgres refuses it. Same root as the 9.1 entry | defer |
| 7 | GraphQL has no `Service.group` link, so a client joins by `serviceGroupId` itself (blind) | low | Admin `Service` exposes only `serviceGroupId`; changing `Service` is outside this story | defer |
| 8 | REST route schemas document only the 200 answer, not 401/404 (blind) | low | Pre-existing across routes; API documentation is audit F-10, Epic 8 | defer |
| 9 | `after()` fails on an empty id list if setup fails first (edge) | low | Only after a setup failure that is already reported | reject |
| 10 | `tiePair` is only length-checked (blind) | false | Removing `id asc` from the ORDER BY failed the ordering test 3 of 3 runs (gap layer) | reject |
| 11 | Sprint status in-progress; spec not in the diff; 9.5 closed here (blind) | false | Step 5 sets review; the spec is withheld by design; the owner asked for 9.5's bookkeeping here | reject |

## Implementation Notes

- Review patches applied: GraphQL error rows assert `data` null, the message and the HTTP status; a read-back test after an edit and a delete; `createGroup` typed as `{ id }`; `update`'s empty-patch branch calls `findById`; the presenter comment corrected.
- mercurius answers HTTP 200 for the resolvers' `UNAUTHENTICATED` refusal, an `ErrorWithProps` without a status, and 404 / 400 for `NotFoundException` / `ArgumentInvalidException`. The tests pin each.
- The list is unbounded by design; pagination is Epic 8 (audit F-14).
- `db:seed` was a no-op (`acme-demo` exists).

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass both times, including the parity and authenticated-surface specs.
- `pnpm run test:integration`, twice -- expected: all pass. A timeline-order failure is this machine's clock (deferred-work.md); re-run it.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds. A no-op if `acme-demo` exists; say so when presenting.
