---
stepsCompleted: [1, 2, 3]
inputDocuments:
  - docs/bmad/planning-artifacts/PRD.md
  - docs/bmad/planning-artifacts/Architecture.md
---

# WatchDog - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for WatchDog, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: Auth + organizations — Better Auth is mounted as a Fastify plugin; users can sign up, sign in, create organizations, switch active orgs, and belong to multiple orgs. (Phase 1)
  - **SATISFIED**: Done - Better Auth is mounted at `/api/auth/*`; signup, signin and organization creation are covered by integration tests through the same Fastify instance the api entrypoint builds, and verified end to end against the Compose stack.
FR2: Teams + membership — Teams and memberships are provided by the Better Auth organization plugin; WatchDog consumes them for active-org context and authorization. (Phase 1)
  - **SATISFIED**: Done - `src/server/auth/organization-context.ts` resolves session to active organization to role, falling back to membership when the session carries no active org, and rejects a role outside the owner/admin/member ladder. Covered by integration tests.
FR3: Tenant isolation — All WatchDog tenant-scoped tables carry `org_id`; repository transactions set `app.current_org_id`; Postgres RLS prevents cross-org reads/writes. (Phase 1)
  - **SATISFIED**: Done - service_groups carries RLS enabled and FORCEd; 12 integration tests prove isolation, and a structural test covers every future org_id table.
FR4: Services + service groups — Authorized v1 users can create, update, group, archive/restore, and manually override service status. (Phase 2)
FR5: Effective service status — Service status resolves via the canonical precedence rule. (Phase 2)
FR6: Incidents — Authorized v1 users can create incidents, assign affected services, set impact, and transition through the incident lifecycle. (Phase 2)
FR7: Incident updates — Incident updates are append-only and visible on admin and public status surfaces. (Phase 2)
FR8: Maintenance — Authorized v1 users can schedule maintenance windows and publish maintenance lifecycle events. (Phase 2)
FR9: Maintenance auto-transitions — Maintenance windows automatically transition based on time. (Phase 2)
FR10: Monitoring configs — Authorized v1 users can configure HTTP(S), TCP, keyword-match, and SSL-expiry checks. (Phase 5)
FR11: Monitoring worker — The `worker` entrypoint executes checks on configured intervals and persists results. (Phase 5)
FR12: Check results storage — Check results are append-only and partitioned; daily uptime rollups are generated. (Phase 5)
FR13: Draft auto-incidents — After N consecutive monitor failures, the system creates a draft incident requiring human confirmation. (Phase 5)
FR14: Public SSE — Public status pages receive live incident, maintenance, and service-status updates over SSE. (Phase 4)
FR15: Admin GraphQL subscriptions — Admin dashboards receive real-time updates through GraphQL subscriptions. (Phase 4)
FR16: LISTEN/NOTIFY backplane — Cross-process fanout works between `api` and `worker` using Postgres `LISTEN/NOTIFY`. (Phase 4)
FR17: Public status page — `/status/:orgSlug` renders the organization's services, active incidents, scheduled maintenance, and uptime history. (Phase 3)
FR18: 90-day uptime — Public pages show 90-day uptime bars backed by daily rollups. (Phase 3)
FR19: Email notifications — Mailpit is included in compose; notification emails are generated for subscribed users. (Phase 6)
FR20: RSS/Atom feed — Public status pages expose a feed for incident and maintenance lifecycle events. (Phase 6)
FR21: Public subscribe flow — Visitors can subscribe to public status updates by email. (Phase 6)
FR22: AI Incident Copilot — AI can draft incident updates, suggest impact/affected services, and draft postmortems. All outputs require human approval. (Phase 6)
FR23: AI NL Query — Users can ask natural-language questions over status and uptime history. (Phase 6)
FR24: AI weekly digest — AI can draft a weekly operational digest for human review. (Phase 6)
FR25: AI provider port — AI use cases depend on a provider-agnostic port; Azure AI Foundry is only an adapter implementation. (Phase 6)
FR26: REST API — REST endpoints exist under `/api` with TypeBox schemas and Swagger coverage. (Phase 3)
FR27: GraphQL API — GraphQL queries/mutations/subscriptions cover admin workflows. (Phase 3)

### NonFunctional Requirements

NFR28: Full test suite — Unit, integration, Cucumber/Gherkin E2E, and k6 load tests exist for the v1 workflows. (Phase 6)
NFR29: Docker Compose — One `docker-compose` runs migration, API, worker, Postgres, and Mailpit. (Phase 6)
  - **SATISFIED**: Done - postgres, mailpit, migrate, api and worker all report healthy from one image.
NFR30: CI — GitHub Actions runs check, unit tests, migrations, integration tests, E2E tests, k6 smoke, and Docker build validation against a Postgres service container. (Phase 6)
  - **PARTIAL**: Partial - check, database and docker jobs run. Cucumber E2E and k6 smoke are not wired yet.
NFR31: No deploy target — CI intentionally stops at verification and does not deploy. (Phase 6)
  - **SATISFIED**: Done - no deployment job exists.

### Additional Requirements

**Starter template: already applied — do not generate a scaffolding story.**

The Architecture names `marcoturi/fastify-boilerplate` as the starter, but it has already been scaffolded, converted from yarn to pnpm, retooled to Biome and k6, and merged. The usual "Epic 1 Story 1 initializes the project from the starter template" story must NOT be created. Verify against the repository before writing any setup story.

Already implemented; re-planning any of it is a defect:

- Scaffold and toolchain: pnpm 12 single package, Biome, k6, `tsx` in development and `tsc` + `resolve-tspaths` for production
- Module boundaries enforced by dependency-cruiser, including `no-cross-module-deps`
- Better Auth schema frozen as a DBMate migration, with `pnpm run auth:schema:check` detecting drift in CI
- Two-entrypoint runtime: `docker compose up` runs postgres, mailpit, migrate, api and worker, all healthy
- Roles and grants: `watchdog_app` is `nosuperuser` and `nobypassrls`; `ALTER DEFAULT PRIVILEGES` covers future tables
- Tenant isolation proven: `service_groups`, `withTenantTransaction`, 12 integration tests plus a structural RLS-coverage test
- Better Auth mounted at `/api/auth/*` with active-organization and role resolution

Technical requirements that constrain every story:

- Every tenant-scoped read or write goes through `withTenantTransaction`; `SET LOCAL` is transaction-scoped and SQL outside a transaction silently sees nothing
- Any new table carrying `org_id` needs RLS enabled, `FORCE`d, and at least one policy, or `tenant-rls-coverage.integration.test.ts` fails
- An unset `app.current_org_id` reads back as `''` rather than NULL; a policy must never treat unset as unrestricted
- Handlers never accept `orgId` from user input; it comes from request context
- Better Auth identifiers are always double-quoted; WatchDog tables stay snake_case
- Modules never import each other; cross-module contracts live in `src/shared/events/` with their own payload types
- `LISTEN/NOTIFY` is a signal, not a durable bus. Payloads carry `{eventName, orgId, aggregateType, aggregateId, occurredAt, version}` and subscribers re-query
- Status ladders are `text` with `CHECK` constraints, never Postgres enum types
- Services are archived, never hard-deleted
- Migrations are DBMate only, and an applied migration is never edited
- Definition of done for every story: `pnpm run check`, `pnpm run test`, `pnpm run test:integration` and `pnpm run auth:schema:check` all pass; any new tenant table has RLS enabled and `FORCE`d with a policy; any emitted event exists in the DOMAIN catalog

### UX Design Requirements

None. WatchDog v1 is backend-first and ships no UI surface; the public status page is a server-rendered read model, and no UX design contract exists in the planning artifacts. No UX-DRs were extracted, and none should be invented during epic design.

### FR Coverage Map

FR1: Epic 1 — auth and organizations; partial, two clauses remain
FR2: Epic 1 — teams and membership, consumed for org context and role
FR3: Epic 1 — tenant isolation; satisfied
FR4: Epic 2 — services and service groups
FR5: Epic 2 — effective service status; last story in the epic
FR6: Epic 2 — incidents
FR7: Epic 2 — incident updates, append-only
FR8: Epic 2 — maintenance windows
FR9: Epic 2 — maintenance auto-transitions
FR10: Epic 5 — monitoring configuration
FR11: Epic 5 — monitoring worker
FR12: Epic 5 — check results storage and partitioning
FR13: Epic 5 — draft auto-incidents
FR14: Epic 4 — public SSE
FR15: Epic 4 — admin GraphQL subscriptions
FR16: Epic 4 — LISTEN/NOTIFY backplane
FR17: Epic 3 — public status payload
FR18: Epic 5 — 90-day uptime; moved from ROADMAP phase 3 because it needs the rollups Epic 5 builds
FR19: Epic 6 — email notifications
FR20: Epic 6 — RSS/Atom feed
FR21: Epic 6 — public subscribe flow
FR22: Epic 7 — AI incident copilot
FR23: Epic 7 — AI natural-language query
FR24: Epic 7 — AI weekly digest
FR25: Epic 7 — AI provider port
FR26: Epic 8 — REST contract and Swagger coverage; parity contract decided in Epic 2's first slice
FR27: Epic 8 — GraphQL parity with REST; enforced per-slice, verified here
NFR28: Epic 8 — full unit, integration, Cucumber and k6 suites
NFR29: satisfied — one Compose stack runs migrate, api, worker, postgres and mailpit
NFR30: Epic 8 — CI carries the full suite
NFR31: satisfied — CI contains no deployment job

## Epic List

### Epic 1: Tenanted access

Operators sign up, create organizations, work alongside teammates, and every organization's data is invisible to every other.
**FRs covered:** FR1 (partial), FR2, FR3

Already delivered: Better Auth mounted at `/api/auth/*`, signup, signin, organization creation, active-organization resolution, role lookup against the owner/admin/member ladder, and proven tenant isolation on `service_groups`.
Remaining: two clauses of FR1 that carry no tests.

- Story 1.1 — switch the active organization. The only path that writes `session.activeOrganizationId`.
- Story 1.2 — belong to more than one organization, each resolving independently. This is what makes the `firstMembershipOf` fallback non-trivial.

### Epic 2: Service catalog and status communication

An operator can describe what they run and tell customers what is happening to it: services and groups, archive and restore, manual overrides, incidents with append-only updates, scheduled maintenance with automatic transitions, and the precedence rule that resolves all of it into one effective status.
**FRs covered:** FR4, FR5, FR6, FR7, FR8, FR9

**Story order is fixed and is not step 3's to choose:** services and groups (FR4) → incidents and updates (FR6, FR7) → maintenance and transitions (FR8, FR9) → effective status **last** (FR5). FR5's precedence rule reads active incident impact and active maintenance, so it cannot be built before they exist.

- The first slice also decides REST/GraphQL parity as a mechanical contract — a shared schema both surfaces derive from, or a contract test that fails the build when they diverge. Not a checklist item deferred to Epic 8.
- A seed story produces a realistic organization for humans: services in groups, an active incident with updates, a scheduled maintenance window. Seed data is for demonstration only. Tests build and tear down their own fixtures, and the seed writes through commands, never raw SQL.

### Epic 3: The public status payload

A client or integrator fetches an organization's current status, active incidents and scheduled maintenance from `/status/:orgSlug` without authenticating. The beneficiary is an integrator, not a human visitor; v1 ships no UI.
**FRs covered:** FR17

- The first story is one throwaway wireframe of the page the payload would feed. Not a frontend: a constraint, so the payload shape is designed against something rather than guessed, and grouping, ordering and "degraded since 14:02" are representable later.

### Epic 4: Live updates

Public and admin surfaces update without a refresh: SSE for public pages, GraphQL subscriptions for admin, both fed across processes by the Postgres LISTEN/NOTIFY backplane.
**FRs covered:** FR14, FR15, FR16

### Epic 5: Automated monitoring and uptime history

Outages are detected rather than noticed. Synthetic checks run on schedule, results are stored and rolled up into 90-day history, and repeated failures propose a draft incident that a human confirms.
**FRs covered:** FR10, FR11, FR12, FR13, FR18

- Carries the monitor half of FR4's archive semantics, moved from Story 2.4. The due-monitor query joins `services` and filters `services.archived_at IS NULL`, so archiving suspends a service's monitors without writing to them and restoring resumes the enabled ones. Story 2.4 cannot verify this because it writes nothing to monitors; the story that builds the query must.

### Epic 6: Subscriber notifications

People find out without watching the page: email to confirmed subscribers, RSS/Atom feeds, and a public subscribe flow. This is the first output a human consumes without needing a client.
**FRs covered:** FR19, FR20, FR21

### Epic 7: AI assistance

An operator drafts incident updates, postmortems and weekly digests with assistance, and queries status history in natural language. Every output is human-approved; nothing is published autonomously.
**FRs covered:** FR22, FR23, FR24, FR25

**BLOCKED.** `docs/genesis/AI.md` line 35 still carries an unresolved `TODO(human)`: the Azure AI Foundry model name, deployment name, API version, endpoint configuration and credential source. Every other genesis TODO has been closed. A swappable provider port does not help if the adapter cannot authenticate to be tested. Resolve before this epic starts, not during it.

### Epic 8: Release readiness

The API surfaces are contract-verified and the full test suite runs in CI. A closing epic, not a leading infrastructure one: it confirms what earlier epics built rather than starting from nothing.
**FRs covered:** FR26, FR27, NFR28, NFR30


## Story Generation Constraints

Binding on step 3. Each was settled deliberately; none is a default.

1. **One slice, one module.** No story spans two modules. `dependency-cruiser` forbids the imports, so a cross-module story cannot be implemented cleanly regardless.
2. **Budget.** One migration, one command *or* one query, its route and resolver, its tests. A story needing two commands is two stories. The module rule bounds blast radius; this bounds volume.
3. **Declared actor.** Every story names its actor as human or system, and never invents one. Nobody is the user of `RefreshUptimeRollupsCommand`; its actor is the worker. Epic 3 does have a real consumer even without a UI, so the user-story form is made honest rather than abandoned.
4. **Acceptance criteria are derived, not generated — from both sources.** A verification line sets the *test surface*; the owning document sets the *rule*. FR5's line names four inputs to status resolution and says nothing about how they combine, and a story derived from the line alone described a cascade where DOMAIN specifies a worst-of reduction. Read the verification line for what must be proven and DOMAIN or ARCHITECTURE for what is true. Three further contradictions were found the same way: draft dismissal's status versus its event, the starting status of a manually created incident, and `is_public` as an exclusion axis the verification line never mentions.    `docs/genesis/ROADMAP.md`'s Definition of Done carries 31 reviewed, specific, testable verification statements. Each story cites the verification line it satisfies, and its Given/When/Then must be a faithful expansion of that line. Regenerating criteria over reviewed ones is the drift this project was built to avoid.
5. **An untraceable story is a signal.** A story mapping to no verification line is either out of scope or evidence ROADMAP missed something. Surface it rather than writing it.
6. **RLS in the acceptance criteria.** Any story creating a table carrying `org_id` states RLS enabled, `FORCE`d, and a policy as acceptance criteria. The structural test reports a hole after it is dug; the criterion prevents digging it.
7. **Name the files and the layer.** Every story names the paths it touches and whether it is proven by unit, integration or E2E tests.
8. **Per-story definition of done.** `pnpm run check`, `pnpm run test`, `pnpm run test:integration` and `pnpm run auth:schema:check` all pass; any emitted event exists in the DOMAIN catalog; REST and GraphQL parity for the slice.

## Epic 1: Tenanted access

Operators sign up, create organizations, work alongside teammates, and every organization's data is invisible to every other.

**FRs covered:** FR1 (partial), FR2, FR3

Delivered before this epic was written: Better Auth mounted at `/api/auth/*`, signup, signin, organization creation, active-organization resolution, role lookup against the owner/admin/member ladder, and tenant isolation proven on `service_groups`. The two stories below close the clauses of FR1 that carried no tests.

> Writing these surfaced a gap in ROADMAP itself: FR1's requirement named five capabilities while its verification line covered four, omitting switching and multi-organization membership. FR2 said nothing about a user holding different roles in different organizations. Both verification lines were extended in `docs/genesis/ROADMAP.md` — the owning document — and re-transcribed here before these criteria were derived.

### Story 1.1: Switch the active organization

As an operator who belongs to more than one organization,
I want to switch which organization is active,
So that the work I do next is scoped to the one I mean.

**Actor:** human
**Satisfies:** FR1 verification — "switching the active organization"
**Files:** `src/server/auth/organization-context.ts`, `src/server/auth/auth.integration.test.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an authenticated operator who is a member of two organizations
**When** they call `POST /api/auth/organization/set-active` with the second organization's id
**Then** `session.activeOrganizationId` is updated to that organization
**And** `resolveOrganizationContext` returns that organization and their role in it

**Given** an authenticated operator
**When** they attempt to set an active organization they are not a member of
**Then** the request is rejected
**And** `resolveOrganizationContext` does not return that organization

### Story 1.2: Belong to more than one organization

As an operator working with more than one team,
I want to hold membership in several organizations at once,
So that one account serves all of them without collision.

**Actor:** human
**Satisfies:** FR1 verification — "a user belonging to multiple organizations"; FR2 verification — "role lookup including different roles held by the same user in different organizations"
**Files:** `src/server/auth/auth.integration.test.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an operator who is owner of one organization and member of another
**When** their role is looked up in each
**Then** each lookup returns that organization's role independently

**Given** an operator with two memberships and no active organization on their session
**When** their organization context is resolved
**Then** the membership fallback selects deterministically by `createdAt` then `id`
**And** repeated resolutions return the same organization

**Given** two organizations the same operator belongs to
**When** tenant-scoped data is read under each in turn
**Then** neither organization's rows are visible under the other

## Epic 2: Service catalog and status communication

An operator can describe what they run, and tell customers what is happening to it: services and groups, archive and restore, manual overrides, incidents with append-only updates, scheduled maintenance with automatic transitions, and the precedence rule that resolves all of it into one effective status.

**FRs covered:** FR4, FR5, FR6, FR7, FR8, FR9

**Story order is fixed and is not open to reordering:** services and groups (FR4) → incidents and updates (FR6, FR7) → maintenance and transitions (FR8, FR9) → effective status **last** (FR5). FR5's precedence rule reads active incident impact and active maintenance, so it cannot be built before they exist.

> Two commands named in ARCHITECTURE's `incident` module are deliberately absent here. `ConfirmDraftIncidentCommand` and `DismissDraftIncidentCommand` act on draft incidents, which only exist once monitoring creates them under FR13. Building them in this epic would mean writing commands with nothing to act on and criteria that could not be derived from FR6's verification line. They move to Epic 5. The incident state machine, including transitions out of `draft`, stays here: it is a pure function and FR6's verification line names it directly.

> These 18 stories were derived from ROADMAP's verification column rather than from the 26-command surface. FR4's line already names five capabilities — create/update, grouping, archive/restore, archived exclusion, manual override — so the story boundaries were settled during the original review rounds. Deriving from commands instead would have produced 23 stories with worse seams.

### Story 2.1: Derive REST and GraphQL from one schema

As the system,
I want a mechanical check that the REST and GraphQL surfaces of a slice agree,
So that they cannot drift apart unnoticed and parity is not deferred to the end of the project.

**Actor:** system
**Satisfies:** FR27 verification — "GraphQL integration tests cover protocol parity with REST where applicable"
**Files:** `src/shared/api/contract/`, `src/modules/*/**/*.schema.ts`, `src/modules/*/**/*.graphql-schema.ts`
**Verification layer:** unit and integration

**Acceptance Criteria:**

**Given** REST validation is authored as TypeBox in `*.schema.ts` and GraphQL as hand-written SDL in `*.graphql-schema.ts`, with no shared source today
**When** this story is implemented
**Then** it records which direction generation would run, if ever, as a decision rather than assuming one exists

**Given** a capability exposed over both REST and GraphQL
**When** a field exists on one surface and not the other, or their types disagree
**Then** a contract test fails the build
**And** the failure names the diverging field and both file paths

**Given** the boilerplate's own `delete-user`, which ships a route and no resolver
**When** the contract test runs against the repository as it stands
**Then** that gap is reported rather than tolerated, proving the check has teeth

### Story 2.2: Create and update a service

As an operator,
I want to add a service to my organization's catalog and change its details,
So that the status page reflects what we actually run.

**Actor:** human
**Satisfies:** FR4 verification — "service create/update"
**Files:** `db/migrations/*_create_services.sql`, `src/modules/service/commands/create-service/` and `.../update-service/` (each: `.handler.ts`, `.route.ts`, `.resolver.ts`, `.schema.ts`, `.graphql-schema.ts`), `src/modules/service/database/service.repository.ts`, `src/modules/service/domain/`, `src/modules/service/service.mapper.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the `services` table is created, carrying `service_group_id` as a nullable FK to the `service_groups` table that already exists from the tenant-isolation work, and `last_known_status` defaulting to `operational` under the same CHECK ladder as the manual override
**When** the migration is applied
**Then** row level security is enabled and `FORCE`d
**And** a policy compares `org_id` to `current_setting('app.current_org_id', true)`
**And** `tenant-rls-coverage.integration.test.ts` passes
**And** no second migration recreates `service_groups`

**Given** an authenticated operator in an organization
**When** they create a service with a name, slug, optional description, `is_public` flag and `display_order`
**Then** it is persisted scoped to their organization
**And** `service.created` is emitted
**And** a second organization cannot read it

**Given** an existing service
**When** its name, description, `is_public` flag or `display_order` is updated
**Then** the change persists
**And** `service.updated` is emitted
**And** an operator from another organization updating it affects zero rows

**Given** a service slug already used in the organization
**When** a second service is created with that slug
**Then** the write is rejected
**And** the same slug remains available to other organizations

**Given** an archived service holding a slug
**When** a new service is created with that same slug
**Then** the write is rejected, because uniqueness is `(org_id, slug)` regardless of `archived_at`
**And** archiving therefore reserves a slug permanently, which is a decision recorded in DOMAIN.md rather than an accident of the index

### Story 2.3: Group services

As an operator,
I want to organize services into named groups,
So that a visitor reads the status page by area rather than as a flat list.

**Actor:** human
**Satisfies:** FR4 verification — "grouping"
**Files:** `src/modules/service/commands/create-service-group/`, `.../update-service-group/`, `.../delete-service-group/` (five files each), `src/modules/service/database/`. No migration: `service_groups` already exists.
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an organization with services
**When** a group is created
**Then** it is scoped to that organization only
**And** `service_group.created` is emitted

**Given** an existing group
**When** it is renamed or given a new display order
**Then** the change persists
**And** `service_group.updated` is emitted

**Given** a group containing services
**When** the group is deleted
**Then** its services survive and become ungrouped
**And** `service_group.deleted` is emitted

**Given** a service and two groups
**When** the service is assigned to one and then moved to the other
**Then** it belongs to exactly one group at a time

**Given** a group belonging to another organization
**When** an operator assigns one of their services to it
**Then** the write is rejected

### Story 2.4: Archive and restore a service

As an operator,
I want to retire a service without destroying its history,
So that past incidents and uptime remain intelligible after we stop running something.

**Actor:** human
**Satisfies:** FR4 verification — "archive/restore commands"
**Files:** `src/modules/service/commands/archive-service/`, `src/modules/service/commands/restore-service/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an active service
**When** it is archived
**Then** `archived_at` is set
**And** `service.archived` is emitted
**And** the row is not deleted

**Given** an archived service
**When** it is restored
**Then** `archived_at` is cleared
**And** `service.restored` is emitted

> The monitor half of FR4's archive semantics is **not** this story's to implement or verify. DOMAIN.md is explicit: archiving writes nothing to monitors, and suspension is a property of the worker's due-monitor query filtering `services.archived_at IS NULL`. Criteria asserting that "monitors are suspended" and "monitors resume" would mislead an implementer into updating monitor rows, which is the opposite of non-destructive. They move to Epic 5, where that query is built.

**Given** a service with incidents and uptime history
**When** it is archived
**Then** that history is still readable

**Given** a service that is already archived
**When** it is archived again
**Then** the command is a no-op and emits no second `service.archived`

**Given** a service that is not archived
**When** it is restored
**Then** the command is a no-op and emits no `service.restored`

### Story 2.5: Exclude archived services from active and public lists

As a visitor,
I want to see only services my organization currently runs,
So that the status page is not cluttered with things that no longer exist.

**Actor:** human
**Satisfies:** FR4 verification — "archived exclusion from public/active lists"
**Files:** `src/modules/service/queries/list-services/`, `src/modules/service/queries/get-service/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an organization with one active and one archived service
**When** services are listed for the admin surface
**Then** only the active service is returned by default

**Given** the same organization
**When** the public read model is composed
**Then** archived services never appear, with or without a filter

**Given** an active service whose `is_public` is false
**When** the public read model is composed
**Then** it is absent, while still appearing on the admin surface
**And** exclusion is therefore two independent axes, archived and non-public, each tested on its own

**Given** an operator restoring a service
**When** they list services with an explicit archived filter
**Then** archived services are returned so one can be chosen

**Given** two organizations each with archived services
**When** either lists its own
**Then** neither sees the other's

**Given** an organization with no services at all
**When** services are listed
**Then** an empty collection is returned rather than an error

### Story 2.6: Override a service's status by hand

As an operator,
I want to set a service's status directly and later clear it,
So that I can communicate something the system cannot infer, and stop when it no longer applies.

**Actor:** human
**Satisfies:** FR4 verification — "manual override behavior"
**Files:** `src/modules/service/commands/set-manual-status-override/`, `.../clear-manual-status-override/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a service
**When** an operator sets a manual status override
**Then** the value is one of `operational`, `degraded`, `partial_outage`, `major_outage`, `maintenance`
**And** a value outside that ladder is rejected by the `CHECK` constraint
**And** `service.manual_override_set` is emitted

**Given** a service carrying an override
**When** the override is cleared
**Then** `manual_status_override` returns to null
**And** `service.manual_override_cleared` is emitted
**And** the service returns to computed status

**Given** a service carrying no override
**When** the override is cleared
**Then** the command is a no-op and emits no event

**Given** an archived service
**When** an override is set on it
**Then** the write succeeds but the service remains excluded from public and active lists

### Story 2.7: Resolve incident state transitions

As the system,
I want one pure function that decides whether an incident transition is legal,
So that the lifecycle is enforced in one place rather than re-derived at every call site.

**Actor:** system
**Satisfies:** FR6 verification — "State-machine tests cover valid and invalid transitions"
**Files:** `src/modules/incident/domain/incident.state-machine.ts`
**Verification layer:** unit

**Acceptance Criteria:**

**Given** DOMAIN's allowed-transition table
**When** each of its entries is evaluated
**Then** exactly these are accepted: `[none] → draft` (worker), `[none] → investigating` (manual creation), `draft → investigating`, `draft → resolved`, `investigating → identified`, `investigating → monitoring`, `investigating → resolved`, `identified → monitoring`, `identified → resolved`, `monitoring → resolved`
**And** every other ordered pair of statuses is rejected

**Given** a monitor-born incident in `draft`
**When** a human dismisses it
**Then** its status becomes `resolved`, because no `dismissed` status exists in the ladder
**And** the event emitted is `incident.dismissed` and never `incident.resolved`, which ARCHITECTURE section 5.4 reserves for incidents that resolved through the public lifecycle

**Given** a resolved incident
**When** any further transition is attempted
**Then** it is rejected

### Story 2.8: Declare an incident

As an operator,
I want to open an incident naming the services it affects and how badly,
So that customers learn what is broken and how much it matters.

**Actor:** human
**Satisfies:** FR6 verification — "State-machine tests cover valid and invalid transitions"
**Files:** `db/migrations/*_create_incidents.sql`, `src/modules/incident/commands/create-incident/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the `incidents` and `incident_service_impacts` tables are created
**When** the migration is applied
**Then** both have RLS enabled and `FORCE`d with a policy
**And** `incident_service_impacts` carries its own `org_id` rather than relying on a join

**Given** an authenticated operator
**When** they create an incident with a title, impact and affected services
**Then** it is persisted scoped to their organization with `source` of `manual`
**And** its status is `investigating`, the only status DOMAIN permits a manually created incident to start in
**And** `incident.created` is emitted
**And** impact is constrained to `none`, `minor`, `major`, `critical`

**Given** an incident affecting services from another organization
**When** the write is attempted
**Then** it is rejected

**Given** an incident created with no affected services
**When** the write is attempted
**Then** it succeeds, since an incident may be declared before its blast radius is known

**Given** the `incidents` table
**When** the migration is applied
**Then** it carries the partial unique index on `(org_id, origin_monitor_id) where status = 'draft'` that DOMAIN specifies as the authoritative guard against duplicate monitor-born drafts

### Story 2.9: Move an incident through its lifecycle

As an operator,
I want to advance an incident's status and finally resolve it,
So that customers can see whether we are still investigating or have fixed it.

**Actor:** human
**Satisfies:** FR6 verification — "State-machine tests cover valid and invalid transitions"
**Files:** `src/modules/incident/commands/update-incident/`, `.../resolve-incident/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an incident under investigation
**When** its status advances along a legal transition
**Then** the change persists and `incident.state_changed` is emitted

**Given** an incident
**When** an illegal transition is requested
**Then** the command is rejected and nothing is written

**Given** an incident being resolved
**When** the command succeeds
**Then** `resolved_at` is set and `incident.resolved` is emitted

**Given** an open incident
**When** its title, impact or affected services are edited without a status change
**Then** the change persists
**And** `incident.updated` is emitted, which is distinct from `incident.state_changed`

**Given** an incident belonging to another organization
**When** any transition is attempted against it
**Then** zero rows are affected

### Story 2.10: Post an incident update

As an operator,
I want to append a message to a running incident,
So that customers get a running account rather than a single stale statement.

**Actor:** human
**Satisfies:** FR7 verification — "Repository tests prove append-only behavior"
**Files:** `db/migrations/*_create_incident_updates.sql`, `src/modules/incident/commands/post-incident-update/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the `incident_updates` table is created
**When** the migration is applied
**Then** RLS is enabled and `FORCE`d with a policy

**Given** an incident with updates
**When** an update is posted
**Then** it is appended with the status at the time of writing
**And** `incident.update_posted` is emitted

**Given** an existing incident update
**When** an edit or delete is attempted through the repository
**Then** it is refused; the timeline is append-only

### Story 2.11: Read an incident timeline in order

As a visitor,
I want to read an incident's updates oldest to newest, and to list incidents,
So that the story of an outage can be followed from start to finish.

**Actor:** human
**Satisfies:** FR7 verification — "API tests prove updates appear in timeline order"
**Files:** `src/modules/incident/queries/get-incident-timeline/`, `.../list-incidents/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an incident with several updates written out of order
**When** its timeline is read
**Then** updates are returned ordered by `created_at`, then by `id`
**And** two updates sharing a timestamp, as happens within one transaction, order deterministically rather than arbitrarily

**Given** an organization with open and resolved incidents
**When** incidents are listed
**Then** both are returned and distinguishable by status
**And** draft incidents are excluded from any public-facing read

**Given** two organizations with incidents
**When** either lists or reads a timeline
**Then** neither sees the other's

### Story 2.12: Schedule a maintenance window

As an operator,
I want to announce planned work against named services ahead of time,
So that customers are not surprised by expected downtime.

**Actor:** human
**Satisfies:** FR8 verification — "Tests cover scheduled, in-progress, and completed states"
**Files:** `db/migrations/*_create_maintenance.sql`, `src/modules/maintenance/commands/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the `maintenance` and `maintenance_services` tables are created
**When** the migration is applied
**Then** both have RLS enabled and `FORCE`d with a policy
**And** status is constrained to `scheduled`, `in_progress`, `completed`

**Given** an authenticated operator
**When** they schedule a window with a start, an end and affected services
**Then** it is persisted as `scheduled` and `maintenance.created` is emitted
**And** a window whose end precedes its start is rejected

**Given** a scheduled window
**When** its times or affected services are updated
**Then** the change persists and `maintenance.updated` is emitted

### Story 2.13: Read and cancel maintenance windows

As an operator,
I want to list, read and cancel planned maintenance,
So that plans that change are not left advertised to customers.

**Actor:** human
**Satisfies:** FR8 verification — "Tests cover scheduled, in-progress, and completed states"
**Files:** `src/modules/maintenance/queries/`, `src/modules/maintenance/commands/delete-maintenance/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an organization with windows in each state
**When** maintenance is listed
**Then** all three states are returned and distinguishable

**Given** a scheduled window for work that never happened
**When** it is deleted
**Then** it is removed and `maintenance.deleted` is emitted

**Given** a scheduled window that an operator cancels
**When** they complete it manually
**Then** its status becomes `completed` and `maintenance.completed` is emitted
**And** the record survives, because cancelling is not the same as never having planned it

**Given** an in-progress window whose work finished early
**When** an operator completes it manually
**Then** its status becomes `completed` before `scheduled_end_at` is reached
**And** the worker's later pass over it is a no-op

**Given** two organizations with windows
**When** either lists or reads one
**Then** neither sees the other's

### Story 2.14: Transition due maintenance automatically

As the worker,
I want to start and complete maintenance windows as their times arrive,
So that an operator does not have to be awake to keep the status page honest.

**Actor:** system — the worker entrypoint
**Satisfies:** FR9 verification — "Worker/integration tests simulate time and verify transitions"
**Files:** `src/modules/maintenance/commands/start-due-maintenance/`, `.../complete-due-maintenance/`, `src/worker.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a scheduled window whose start time has passed
**When** the worker runs its transition pass
**Then** the window becomes `in_progress` and `maintenance.started` is emitted

**Given** an in-progress window whose end time has passed
**When** the worker runs
**Then** the window becomes `completed` and `maintenance.completed` is emitted

**Given** a window that has already been started
**When** the worker runs again over the same window
**Then** no duplicate event is emitted; the pass is idempotent

**Given** a scheduled window whose start and end times have both passed before the worker first runs
**When** the transition pass executes
**Then** it moves directly to `completed`, which DOMAIN lists as a legal `scheduled → completed` worker transition
**And** it does not pass through `in_progress`

**Given** windows belonging to several organizations
**When** the worker runs
**Then** each is transitioned under its own tenant context

### Story 2.15: Resolve effective service status

As the system,
I want one pure function that reduces every input to a single service status,
So that the same answer is given on the public page, the admin surface and in notifications.

**Actor:** system
**Satisfies:** FR5 verification — "Pure-function unit tests cover manual override, active incident impact, active maintenance, and monitor-derived state"
**Files:** `src/modules/service/domain/effective-status.ts`
**Verification layer:** unit

**Acceptance Criteria:**

**Given** a service carrying a manual override
**When** status is resolved
**Then** the override is returned unchanged, whatever the other inputs say

**Given** no manual override
**When** status is resolved
**Then** the result is the **worst of** every active incident's per-service impact, `maintenance` if a window is in progress, and the monitor-derived state
**And** this is a worst-of reduction, not a cascade: maintenance does not require the absence of an incident to be considered

**Given** several active incidents naming the same service with different impacts
**When** status is resolved
**Then** the worst impact among them wins, since `activeIncidentImpacts` is reduced rather than sampled

**Given** an in-progress maintenance window and an active incident of `major` impact
**When** status is resolved
**Then** `major_outage` wins over `maintenance`, which ranks 1 against 4 in `SERVICE_STATUS_RANK`

**Given** no override, no incident, no maintenance and no monitor
**When** status is resolved
**Then** the result is `operational`, the identity value of the reduction

**Given** every combination of the four inputs
**When** each is evaluated
**Then** the reduction holds with no input silently dropped

### Story 2.16: Recompute and announce service status

As the system,
I want a service's status recomputed whenever an input to it changes,
So that `service.status_changed` fires exactly when the answer actually moves.

**Actor:** system — an event handler in the `service` module
**Satisfies:** DOMAIN's `service.status_changed` catalog entry and its Status recomputation section; the FR5 resolution rule reaching its consumers
**Files:** `src/modules/service/commands/recompute-service-status/`, `src/shared/events/` (the cross-module contracts it subscribes to)
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the `service` module
**When** any of `incident.created`, `incident.confirmed`, `incident.state_changed`, `incident.resolved`, `incident.dismissed`, `maintenance.started`, `maintenance.completed`, `maintenance.deleted`, `service.manual_override_set` or `service.manual_override_cleared` is emitted
**Then** effective status is resolved for each affected service using story 2.15's function
**And** the handler reaches those events through `src/shared/events/`, never by importing the `incident` or `maintenance` module

**Given** a service whose recomputed status differs from `last_known_status`
**When** the handler runs
**Then** the new value is written
**And** `service.status_changed` is emitted

**Given** a service whose recomputed status matches `last_known_status`
**When** the handler runs
**Then** nothing is written and no event is emitted
**And** running the handler repeatedly over the same input produces no further events

**Given** an archived service affected by an incident
**When** the handler runs
**Then** it is skipped, since it appears on no public or active list

**Given** services in several organizations affected by one worker pass
**When** the handler runs
**Then** each is recomputed under its own tenant context

### Story 2.17: Serve resolved status through the service queries

As a visitor,
I want to receive each service's effective status rather than its raw fields,
So that I do not have to reimplement the precedence rule to understand the page.

**Actor:** human
**Satisfies:** FR5 verification — the resolution rule reaching its consumers
**Files:** `src/modules/service/queries/list-services/`, `src/modules/service/queries/get-service/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** services in each of the four precedence conditions
**When** they are listed
**Then** each carries `last_known_status`, maintained by story 2.16
**And** the query does not recompute across incidents, maintenance and monitor results per request

**Given** an incident is opened or resolved against a service
**When** the service is read again
**Then** its effective status reflects the change without any cache to invalidate

**Given** the same query over REST and GraphQL
**When** both are called
**Then** the effective status field is identical, as story 2.1's contract test requires

### Story 2.18: Seed a demonstrable organization

As an operator or reviewer,
I want one command that fills an empty database with something realistic,
So that the stack can be shown working without hand-crafting data first.

**Actor:** human
**Satisfies:** NFR29 — demonstrability; the epic's end-to-end path
**Files:** `db/seeds/`, `package.json`
**Verification layer:** none — this is a fixture for people, not for tests

**Acceptance Criteria:**

**Given** a freshly migrated database
**When** `pnpm run db:seed` is run
**Then** one organization exists with services arranged in groups, one active incident carrying updates, and one scheduled maintenance window

**Given** the seed script
**When** it writes
**Then** every row is created through the same commands the API uses, never raw SQL
**And** it runs under a tenant transaction like any other caller

**Given** the test suites
**When** they run against a seeded or unseeded database
**Then** they pass identically
**And** no test reads or mutates seeded rows

**Given** the epic's earlier stories
**When** this story runs
**Then** services, groups, incidents, incident updates and maintenance windows all already exist as commands
**And** the seed is therefore last in the epic rather than first, because it exercises the whole slice
