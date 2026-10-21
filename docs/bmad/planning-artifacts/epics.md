---
stepsCompleted: [1, 2, 3]
epicsWithStories: [1, 2, 3, 9, 5, 4, 6]
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
FR10: Monitoring configs — Authorized v1 users can configure HTTP(S), TCP, keyword-match, and SSL-expiry checks. An SSL-expiry monitor warns operators once per certificate before it expires. (Phase 5)
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
  - **PARTIAL**: check, database, E2E and docker jobs run; k6 smoke is not wired (ARCHITECTURE section 9) and the built image is never booted (Epic 3 retrospective item 21). Closed in Epic 8.
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
Epic 9 — stabilization; adds no FR, and re-verifies FR4, FR6, FR27 and NFR29 against ROADMAP's sharpened verification lines

## Epic List

**Delivery order: 1, 2, 3, 9, 5, 4, 6, 7, 8.** Epic numbers are names, not positions; ROADMAP section 2 owns the order (`sprint-change-proposal-2026-10-06.md`). v1 is API-only (ROADMAP, non-goals), so no browser-UI epic exists. Stories are written for one epic at a time, because the sprint tracker recommends the lowest-numbered backlog story.

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

- Built after Epic 5, so the worker's monitor events are the real cross-process case its Compose test proves.
- Its public event gate applies DOMAIN's "Public status page" rule, not only the draft check.
- `/status/:orgSlug/events` inherits ARCHITECTURE 5.4.1's four bounds, including its rule that a cookie is not a session.
- Stories written 2026-10-18 from the owner's decisions recorded that day in ARCHITECTURE 5.4, 5.4.1, 5.5 and 9: the public stream sends the whole page, streams are capped and expire, a subscription closes within a minute of losing access, and a `compose` CI job proves the cross-process case.

### Epic 5: Automated monitoring and uptime history

Outages are detected rather than noticed. Synthetic checks run on schedule, results are stored and rolled up into 90-day history, and repeated failures propose a draft incident that a human confirms.
**FRs covered:** FR10, FR11, FR12, FR13, FR18

- Carries the monitor half of FR4's archive semantics, moved from Story 2.4. The due-monitor query joins `services` and filters `services.archived_at IS NULL`, so archiving suspends a service's monitors without writing to them and restoring resumes the enabled ones. Story 2.4 cannot verify this because it writes nothing to monitors; the story that builds the query must.
- Carries the monitor half of FR5's precedence rule, the fourth condition Story 2.18 could not construct. Monitor-derived state (`healthy`, `degraded`, `failing`) must reach `resolveServiceStatus` through the recomputation handler, which today passes `monitorState: null`, triggered by `monitor.state_changed`, the monitor event DOMAIN.md's Status recomputation section lists. Verified by a service listing the status its monitor state resolves to.
- **Delivered after Epic 9 and before Epic 4.** It needs no backplane (ROADMAP section 2). The rules its stories derive from were recorded on 2026-10-06: monitor-derived state, the draft path through the `incident` module, recomputation on `monitor.state_changed`, partitions and RLS, and append-only results (DOMAIN); check scheduling, partition maintenance and target safety (ARCHITECTURE sections 6.0.1, 6.1, 6.5).
- Epic 3 retrospective item 23 is carried by the first story that adds a foreign-table read, not a fixed story number. That story adds the allowlist test before the read; every later story extends the explicit allowlist for its approved cross-module reads. The uptime story carries it only if no earlier story triggers it.

### Epic 6: Subscriber notifications

People find out without watching the page: email to confirmed subscribers, an Atom feed (Atom only, decided 2026-10-21), and a public subscribe flow. This is the first output a human consumes without needing a client.
**FRs covered:** FR19, FR20, FR21

- Built from the decisions recorded on 2026-10-06: delivery is derived from durable history into a ledger, at-least-once (ARCHITECTURE section 5.6; DOMAIN, NotificationDelivery). Confirm and unsubscribe links answer in plain text, since v1 is API-only. Story 9.13 must be merged before any story here begins.
- Stories written 2026-10-21 from the owner's sixteen decisions of that day (`epic-6-open-decisions.md`), recorded first in DOMAIN (Subscriber, NotificationDelivery, NotificationCursor) and ARCHITECTURE (5.6, 7.1):
  - a subscription covers the whole page;
  - the subscribe, confirm, unsubscribe and feed surface is REST only;
  - the feed is Atom only, and emails are plain text over SMTP;
  - the anonymous form is throttled by IP and by address;
  - delivery runs from a cursor with an overlap, and no lock is held across a send;
  - the public rule is shared;
  - a log scrub comes first.

  Story 9.13 is merged.

### Epic 7: AI assistance

An operator drafts incident updates, postmortems and weekly digests with assistance, and queries status history in natural language. Every output is human-approved; nothing is published autonomously.
**FRs covered:** FR22, FR23, FR24, FR25

**Unblocked 2026-09-21.** The `TODO(human)` that held this epic is resolved in `docs/genesis/AI.md` section 2.0: `DeepSeek-V4-Flash` (version 2026-04-23) on the `/openai/v1/` route, so there is no API version to pin, authenticated by an API key from `.env`. The epic's first story adds the three `AZURE_AI_FOUNDRY_*` variables to `src/config/env.ts`, all optional, so a missing key degrades to unavailable assistance rather than failing boot, and CI needs no key. The chosen model is a reasoning model without schema-enforced output, and section 2.0 records what that obliges the adapter to do.

### Epic 8: Release readiness

The API surfaces are contract-verified and the full test suite runs in CI. A closing epic, not a leading infrastructure one: it confirms what earlier epics built rather than starting from nothing.
**FRs covered:** FR26, FR27, NFR28, NFR30

- Also carries audit findings F-10 (API documentation), F-11 (CI security, boot and load evidence), F-14 (pagination policy) and the code half of F-18 (trusted proxy), and Epic 3 retrospective item 21 (container smoke test).

### Epic 9: Stabilization

The surfaces Epics 2 and 3 built hold under input and headers nobody tested: GraphQL refuses what REST refuses, the anonymous limit cannot be skipped, an admin client can reopen what it edits, and the worker's health says whether it is working. Delivered before Epics 4–8.
**FRs covered:** none new; re-verifies FR4, FR6, FR27, NFR29


## Story Generation Constraints

Binding on step 3. Each was settled deliberately; none is a default.

1. **One slice, one module.** No story spans two modules. `dependency-cruiser` forbids the imports, so a cross-module story cannot be implemented cleanly regardless.
2. **Budget.** One migration, and a cohesive unit of work over it: one command, one query, or a **cohesive pair** sharing one migration, one domain model, one repository and one route pattern. Create-and-update of a single entity is that pair; two unrelated commands are two stories. The module rule bounds blast radius; this bounds volume.

   *Corrected during story 2.12.* This constraint was written as "one command or one query", which is tighter than the budget actually chosen at the epic level — option (b), the cohesive pair, named `CreateService` + `UpdateService` explicitly. Story 2.2 shipped that pair and every story since has followed the decision rather than the sentence. The sentence now matches the decision.

   **Amended after stories 2.9 and 2.11.** A story may also carry two operations that are *not* a create-and-update pair when its own acceptance criteria *compare* them, because neither alone can demonstrate the criterion. Story 2.9 asserts that editing an incident and advancing it emit different events; story 2.11 asserts that a timeline read and an incident list are both scoped and both ordered. Splitting either would leave a criterion unverifiable in both halves. This is a narrow exception for comparison, not a licence to bundle.
3. **Declared actor.** Every story names its actor as human or system, and never invents one. Nobody is the user of `RefreshUptimeRollupsCommand`; its actor is the worker. Epic 3 does have a real consumer even without a UI, so the user-story form is made honest rather than abandoned.
4. **Acceptance criteria are derived, not generated — from both sources.** A verification line sets the *test surface*; the owning document sets the *rule*. FR5's line names four inputs to status resolution and says nothing about how they combine, and a story derived from the line alone described a cascade where DOMAIN specifies a worst-of reduction. Read the verification line for what must be proven and DOMAIN or ARCHITECTURE for what is true. Three further contradictions were found the same way: draft dismissal's status versus its event, the starting status of a manually created incident, and `is_public` as an exclusion axis the verification line never mentions.    `docs/genesis/ROADMAP.md`'s Definition of Done carries 31 reviewed, specific, testable verification statements. Each story cites the verification line it satisfies, and its Given/When/Then must be a faithful expansion of that line. Regenerating criteria over reviewed ones is the drift this project was built to avoid.
5. **An untraceable story is a signal.** A story mapping to no verification line is either out of scope or evidence ROADMAP missed something. Surface it rather than writing it.
6. **RLS in the acceptance criteria.** Any story creating a table carrying `org_id` states RLS enabled, `FORCE`d, and a policy as acceptance criteria. The structural test reports a hole after it is dug; the criterion prevents digging it.
7. **Name the files and the layer.** Every story names the paths it touches and whether it is proven by unit, integration or E2E tests.
8. **Per-story definition of done.** `pnpm run check`, `pnpm run test`, `pnpm run test:integration`, `pnpm run test:e2e` and `pnpm run auth:schema:check` all pass, and `pnpm run test` passes again with `.env` moved aside, because CI's unit job has none; any emitted event exists in the DOMAIN catalog; REST and GraphQL parity for the slice. *Amended after the Epic 9 retrospective (P1):* the no-`.env` run and `test:e2e` match what CI runs.
9. **Shared test helpers.** A story's tests build fixtures, capture events and send GraphQL through `src/shared/testing/` (`fixtures.ts`, `events.ts`, `graphql.ts`, `tenant.ts`). A helper a story needs that is not there yet goes there, not into the test file. Epics 3 and 9 each ended with the same helpers copied across a dozen suites (Epic 9 retrospective, AV-2).
10. **A deferral states its premise.** A deferral that rests on a bound states the arithmetic behind it: the figure, what it multiplies and the worst case it covers. A deferral or a triage rejection that relies on a later story names that story in `deferred-work.md`, so the later story's spec checks it. Epic 5 deferred a stall as "at most 60 s", which held for one slow check and not for a queue of them (481 s observed), and rejected an archived-service race because "5.10 and 5.15 consumers read the service themselves", which 5.15 did not (Epic 5 retrospective, P3, DR-1, DR-2).
11. **A fix's test is mutation-checked.** The test is shown to fail with the fix reverted, and the spec's Implementation Notes record that it did. Stories 5.14, 5.15 and 5.16 each put the old behaviour back and saw the new test fail; the definition of done did not ask for it (Epic 5 retrospective, P2).

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
>
> *As built (Epic 2 retrospective, AV-7):* what moved to Epic 5 is **creating** drafts, which needs monitoring. Confirming and dismissing one are live already, because `TransitionIncidentCommand` serves every move on the ladder: `draft -> investigating` emits `incident.confirmed`, and `draft -> resolved` emits `incident.dismissed`. Epic 5 adds no separate confirm or dismiss command.

> These 19 stories, 18 as first written plus the split of 2.13, were derived from ROADMAP's verification column rather than from the 26-command surface. FR4's line already names five capabilities — create/update, grouping, archive/restore, archived exclusion, manual override — so the story boundaries were settled during the original review rounds. Deriving from commands instead would have produced 23 stories with worse seams.

### Story 2.1: Keep REST and GraphQL from drifting apart

As the system,
I want a mechanical check that the REST and GraphQL surfaces of a slice agree,
So that they cannot drift apart unnoticed and parity is not deferred to the end of the project.

**Actor:** system
**Satisfies:** FR27 verification — "GraphQL integration tests cover protocol parity with REST where applicable"
**Files:** `src/shared/api/contract/`, `src/modules/*/**/*.schema.ts`, `src/modules/*/**/*.graphql-schema.ts`
**Verification layer:** unit and integration

*Retitled after implementation.* The original title, "Derive REST and GraphQL from one schema", promised generation. The story's own criteria asked for a recorded decision about which direction generation would run *if ever*, plus a contract test that fails the build on drift, and that is what `2b9df8f` built. The title now matches the criteria (Epic 2 retrospective, AV-6).

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
**Files:** `src/modules/service/queries/list-services/` (as built: `7bcda44`. `get-service/` was listed here but arrived with story 2.18)
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
**Files:** `src/modules/service/commands/set-status-override/`, `.../clear-status-override/` (as built: `7bcea7e`)
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
**Files:** `src/modules/incident/commands/transition-incident/`, `.../update-incident/` (as built: `2a91614`. One transition command serves every move, so there is no separate `resolve-incident/`)
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

*Fixed after Epic 2:* stories 2.8 and 2.9 were built before this story created `incident_updates`, so declaring and transitioning appended no entry, contrary to DOMAIN's invariant that every transition does. Both now append one in the same transaction, with an optional operator message or a customer-worded default, attributed to the actor. Found while writing the story 2.19 seed.

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

### Story 2.13: Read maintenance windows

As an operator,
I want to see planned maintenance and its state,
So that I know what is scheduled, running, and finished.

**Actor:** human
**Satisfies:** FR8 verification — "Tests cover scheduled, in-progress, and completed states"
**Files:** `src/modules/maintenance/queries/list-maintenance/`, `.../get-maintenance/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an organization with windows in each state
**When** maintenance is listed
**Then** all three states are returned and distinguishable

**Given** a window
**When** it is read on its own
**Then** its affected services come with it

**Given** two organizations with windows
**When** either lists or reads one
**Then** neither sees the other's
**And** reading another organization's window is a 404 rather than an empty result

### Story 2.14: End a maintenance window

As an operator,
I want to cancel work that will not happen and close out work that has,
So that the schedule reflects reality rather than intent.

**Actor:** human
**Satisfies:** FR8 verification — "Tests cover scheduled, in-progress, and completed states"
**Files:** `src/modules/maintenance/commands/delete-maintenance/`, `.../complete-maintenance/`
**Verification layer:** integration

> Split from the original story 2.13, which carried four operations: two reads and two writes. The budget allows a cohesive pair, not four. The two halves also divide cleanly by criterion, and these two writes qualify under the comparison exception - the point of the story is that deleting and completing are *different*, so both are needed to show it.

**Acceptance Criteria:**

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

**Given** a completed window
**When** completion is attempted again
**Then** it is a no-op emitting nothing

### Story 2.15: Transition due maintenance automatically

As the worker,
I want to start and complete maintenance windows as their times arrive,
So that an operator does not have to be awake to keep the status page honest.

**Actor:** system — the worker entrypoint
**Satisfies:** FR9 verification — "Worker/integration tests simulate time and verify transitions"
**Files:** `src/modules/maintenance/commands/transition-due-maintenance/`, `src/worker.ts` (as built: `1c37115`. One command starts and completes, so the two halves cannot disagree about the clock)
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

### Story 2.16: Resolve effective service status

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
**Then** `partial_outage` wins over `maintenance` — DOMAIN maps `major` to `partial_outage`, which ranks 3 against 1

**Given** an in-progress maintenance window and an active incident of `critical` impact
**When** status is resolved
**Then** `major_outage` wins, the only impact that maps there

> Corrected while implementing: this criterion originally claimed a `major` incident yields `major_outage`. DOMAIN's `statusFromIncidentImpact` says otherwise, and it owns the rule. The principle the criterion was written to test - an incident outranks maintenance rather than being displaced by it - was right; the example was not.

**Given** no override, no incident, no maintenance and no monitor
**When** status is resolved
**Then** the result is `operational`, the identity value of the reduction

**Given** every combination of the four inputs
**When** each is evaluated
**Then** the reduction holds with no input silently dropped

### Story 2.17: Recompute and announce service status

As the system,
I want a service's status recomputed whenever an input to it changes,
So that `service.status_changed` fires exactly when the answer actually moves.

**Actor:** system — an event handler in the `service` module
**Satisfies:** DOMAIN's `service.status_changed` catalog entry and its Status recomputation section; the FR5 resolution rule reaching its consumers
**Files:** `src/modules/service/commands/recompute-service-status/`, `src/shared/events/` (the cross-module contracts it subscribes to)
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the `service` module
**When** any of `incident.created`, `incident.confirmed`, `incident.state_changed`, `incident.resolved`, `incident.dismissed`, `incident.updated`, `maintenance.started`, `maintenance.completed`, `maintenance.deleted`, `maintenance.updated`, `service.manual_override_set`, `service.manual_override_cleared` or `service.restored` is emitted
**Then** effective status is resolved for each affected service using story 2.16's function
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

**Given** an edit that drops a service from an active incident, or the deletion of an in-progress window
**When** the handler runs
**Then** the service is recomputed even though the link that named it is gone

**Given** several recomputations of one organization running concurrently
**When** they finish
**Then** a change is written and announced exactly once

**Given** a draft incident confirmed into `investigating`
**When** the transition commits
**Then** `incident.confirmed` is emitted alongside `incident.state_changed`

*Amended during implementation:* `incident.updated`, `maintenance.updated` and `service.restored` were missing from the trigger list, recomputation covers every live service in the organization, and `incident.confirmed` was in DOMAIN's catalog but emitted by nothing. DOMAIN.md's Status recomputation section was changed first.

### Story 2.18: Serve resolved status through the service queries

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
**Then** each carries `last_known_status`, maintained by story 2.17
**And** the query does not recompute across incidents, maintenance and monitor results per request

**Given** an incident is opened or resolved against a service
**When** the service is read again
**Then** its effective status reflects the change without any cache to invalidate

**Given** the same query over REST and GraphQL
**When** both are called
**Then** the effective status field is identical, as story 2.1's contract test requires

*Amended during implementation:* the fourth precedence condition, monitor-derived state, cannot be constructed until Epic 5 adds monitors. This story verifies the manual override, active incident and active maintenance conditions plus the no-input default, and the monitor case is carried into Epic 5's entry. The reads stay on the authenticated admin surface, because Epic 3 owns the unauthenticated payload. A read by id returns an archived service with `archivedAt` set, since DOMAIN excludes archived services only from lists and public pages. A read issued the instant a status-moving command returns can precede its recomputation; see DOMAIN.md, Status recomputation.

### Story 2.19: Seed a demonstrable organization

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

## Epic 3: The public status payload

A client or integrator fetches an organization's current status, active incidents and scheduled maintenance from `/status/:orgSlug` without authenticating, and gets back one document they can render or poll.

**FRs covered:** FR17

**Story order is fixed:** the wireframe (3.1) before the payload, because the epic's constraint is that the shape is designed against something rather than guessed; the pre-tenant path (3.2) before the payload that depends on it; the payload (3.3) before the end-to-end test that fetches it (3.4).

> **Reading other modules' tables.** The `status-page` module composes services, incidents and maintenance. Modules do not import each other, and `dependency-cruiser` enforces that, so its repository reads those tables with SQL under the tenant transaction — the same shape story 2.17's status recomputation uses, and with the same cost the Epic 2 retrospective recorded (AV-2): a dependency on two other modules' schemas that no structural rule can see. Worth re-stating in the story rather than discovering again.

> **Uptime is shaped here and filled in Epic 5.** ROADMAP's phase 3 line includes the "90-day uptime read model shape", while the data behind it is FR18, which Epic 5 owns with the monitors that produce it. Decided 2026-09-15: the payload carries the field with its final shape and an explicitly empty value, so an integrator codes against a contract that does not break when rollups arrive.

### Story 3.1: Wireframe the page the payload feeds

As an operator,
I want one throwaway sketch of the status page a visitor would read,
So that the payload is designed against something concrete instead of guessed.

**Actor:** human
**Satisfies:** the epic's own constraint. It maps to no ROADMAP verification line, deliberately — see the note below
**Files:** `docs/genesis/public-status-wireframe.md`
**Verification layer:** none — a document, not code

**Acceptance Criteria:**

**Given** v1 ships no UI
**When** the wireframe is drawn
**Then** it shows every element the payload must carry: services in their groups with a status each, active incidents with their latest update, scheduled maintenance, and where 90-day uptime will sit
**And** it is marked throwaway: no framework, no component library, nothing to keep building on

**Given** the wireframe
**When** the payload shape is designed against it
**Then** every field traces to something on the sketch
**And** anything on the sketch with no field is either added to the payload or struck out with a reason

**Given** grouping, ordering, and phrases like "degraded since 14:02"
**When** the sketch is reviewed
**Then** each is either representable from the payload as shaped, or recorded as out of scope for v1

> Constraint 5 says an untraceable story is a signal. This one is traceable to the epic rather than to ROADMAP, produces no production code, and is written down rather than smuggled in as part of another story.

### Story 3.2: Resolve an organization from its public slug

As an integrator,
I want `/status/:orgSlug` to identify the organization without a session,
So that anyone holding the link can fetch the page.

**Actor:** system — the pre-tenant path
**Satisfies:** FR17 verification — the route is keyed by org slug; ARCHITECTURE sections 3 and 6.4, which name this the pre-tenant path
**Files:** `src/modules/status-page/queries/resolve-organization-by-slug/`, `src/modules/status-page/queries/get-public-status-page/` (the public route the criteria below allowlist; story 3.3 fills its payload), `src/modules/status-page/database/`, `src/server/index.ts` (public routes load without the `/api` prefix), `src/shared/api/contract/authenticated-surface.spec.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a request carrying no session
**When** it names a slug that exists
**Then** the organization id is resolved from Better Auth's `organization` table, which sits outside WatchDog's RLS and is the one place a request with no tenant may look
**And** every tenant-scoped read after it runs under `withTenantTransaction` with that id, so RLS still decides what is visible

**Given** a slug that matches no organization
**When** it is resolved
**Then** the answer is 404 and the body distinguishes nothing further, so a miss reveals nothing beyond "not found"
**And** that is all it claims: a hit answers 200 with the organization's name, and every organization has a public page from the moment it is created, so the route is not what would prevent enumeration (reworded after the fact — Epic 3 retrospective, R-11)

**Given** a resolved id
**When** it reaches a repository
**Then** it is validated against the Better Auth id shape before any GUC is set, as every other tenant entry point does

**Given** the public route and resolver files
**When** the authenticated-surface spec runs
**Then** they appear in `PUBLIC_BY_DESIGN` with their reason, which is the first entry that list has carried since it was introduced
**And** every other route and resolver still resolves an organization context

### Story 3.3: Serve the public status payload

As an integrator,
I want one unauthenticated request to return an organization's services, active incidents and scheduled maintenance,
So that I can render or poll a status page without credentials.

**Actor:** human — an integrator, not a browser
**Satisfies:** FR17 verification — `/status/:orgSlug` renders services, active incidents, scheduled maintenance and uptime history (the payload half; 3.4 covers the E2E half)
**Files:** `src/modules/status-page/queries/get-public-status-page/` (handler, route, resolver, schema, graphql-schema), `src/modules/status-page/dtos/`, `src/modules/status-page/database/`, `src/shared/domain/status-inputs.ts` and the service, incident and maintenance `*.types.ts` that re-export from it: the payload names all three ladders, and a module may not import another module to reach one
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an organization with public, non-public and archived services
**When** the payload is fetched
**Then** only services that are `is_public` and not archived appear
**And** each carries its effective status read from `last_known_status`, never recomputed per request
**And** they arrive in their groups, ordered by `display_order` then name, so a renderer needs no second sort

**Given** incidents in every status, including a monitor-born draft
**When** the payload is fetched
**Then** only active incidents appear — `investigating`, `identified`, `monitoring` — each with its timeline entries oldest to newest
**And** no draft appears, because a draft describes an outage customers were never told about

**Given** scheduled, in-progress and completed maintenance windows
**When** the payload is fetched
**Then** the scheduled and in-progress windows appear with the services they affect
**And** completed windows do not, since the page describes what is happening rather than what has

**Given** Epic 5 has not yet built rollups
**When** the payload is fetched
**Then** the uptime field is present in its final shape and explicitly empty
**And** an integrator reading it can tell "no data yet" from "100% uptime"

**Given** two organizations
**When** either page is fetched
**Then** the other's services, incidents and maintenance never appear, because every read runs under the resolved organization's tenant transaction

**Given** the same payload over REST and GraphQL
**When** both are fetched
**Then** they are identical, held by the parity contract for the request shape and by a value test for the response, as service reads are

### Story 3.4: Prove the public page end to end

As a maintainer,
I want the public route exercised end to end against a running application,
So that FR17 is verified by the layer its verification line names.

**Actor:** system
**Satisfies:** FR17 verification — "E2E tests cover public route rendering by org slug"; NFR28, which says an E2E suite exists
**Files:** `tests/status-page/public-status.feature`, `tests/status-page/public-status.steps.ts`, `tests/support/`, `.github/workflows/ci.yml`, `cucumber.mjs`, `package.json` (the last two amended after the fact: the story's PR changed both, and they carry behaviour — Epic 3 retrospective, AV-7)
**Verification layer:** E2E (Cucumber)

**Acceptance Criteria:**

**Given** an organization built by the scenario's own fixture through the API, never the seed
**When** `/status/:orgSlug` is fetched with no credentials
**Then** the response names its public services with their statuses, its active incident, and its scheduled window

**Given** a private service, an archived service and a draft incident in that same organization
**When** the page is fetched
**Then** none of them appear, so the exclusions are proven at the layer a consumer actually sees

**Given** `pnpm run test:e2e` today reports 0 scenarios, because the boilerplate's features were removed with its modules
**When** this story lands
**Then** the command runs real scenarios
**And** breaking the public route fails them

**Given** CI runs check, unit and integration but not E2E
**When** this story lands
**Then** the workflow runs the E2E suite too, which is what NFR30 already claims

## Epic 9: Stabilization

The surfaces Epics 2 and 3 built hold under input and headers nobody tested: GraphQL refuses what REST refuses, the anonymous limit cannot be skipped, an admin client can reopen what it edits, and the worker's health says whether it is working.

**FRs covered:** none new. Re-verifies FR4, FR6, FR27 and NFR29 against ROADMAP's sharpened verification lines, and ARCHITECTURE 5.4.1.

Added by `sprint-change-proposal-2026-10-06.md`, from the audit of 2026-10-05 (findings F-01 to F-17). **Delivered before Epics 4–8.** Stories 9.1 and 9.2 come first and may run in parallel. 9.11 follows 9.1, 9.3 and 9.4, because its refusal cases need theirs. The rest are independent. 9.1–9.11 must land for the epic to close; 9.12–9.14 should, and 9.13 must land before Epic 6.

> Constraint 1 (one module per story) is why F-01 is three stories: 9.1 service, 9.3 incident, 9.4 maintenance. Story 9.11 is test-only and drives the app over HTTP, importing no module, the same exception `src/shared/api/input-validation.integration.test.ts` already makes.

### Story 9.1: GraphQL refuses what REST refuses — services and groups

As an operator using GraphQL,
I want the same input rules REST applies,
So that I cannot store a service the REST API would have refused.

**Actor:** human
**Satisfies:** FR27 verification — "GraphQL refuses each input the REST schema refuses"; ARCHITECTURE section 7.1, "Rules have one source and both surfaces apply it". Audit F-01, part 1 of 3.
**Files:** `src/shared/validation/`, the `.handler.ts` of `create-service`, `update-service`, `create-service-group`, `update-service-group` and `set-status-override` under `src/modules/service/commands/`, a GraphQL refusal integration test
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the audit's reproduction, `createService` over GraphQL with `name: ""`, `slug: "INVALID SLUG!"` and `displayOrder: -1`
**When** it is sent
**Then** it is refused with a client error the GraphQL formatter passes through, not "Internal Server Error"
**And** no row is written and no `service.created` is emitted

**Given** each rule in the service slice's TypeBox request schemas — name length, slug pattern and length, non-negative display order, UUID group id, the override ladder
**When** a value breaking it reaches the matching mutation over GraphQL
**Then** it is refused exactly where REST refuses it, one test per rule

**Given** a valid input
**When** it is sent over both surfaces
**Then** both persist equivalent rows

**Given** the rules
**When** the story lands
**Then** each is written once, and both surfaces apply that one definition rather than a hand-copied second version in the handler

### Story 9.2: The anonymous GraphQL limit holds whatever cookie arrives

As an operator running WatchDog,
I want the anonymous GraphQL rate limit to hold for every request without a valid session,
So that a junk `Cookie` header cannot remove the bound on my public surface.

**Actor:** human — the operator who relies on the bound
**Satisfies:** ARCHITECTURE section 5.4.1 — "The exemption is decided by resolving the session, never by the presence of a `Cookie` header". Audit F-02.
**Files:** `src/server/index.ts`, `src/modules/status-page/public-surface-bounds.integration.test.ts`, `AGENTS.md` (the convention lands with the change, Epic 3 lesson P2)
**Verification layer:** integration

**Acceptance Criteria:**

**Given** the anonymous bucket is exhausted for one client address
**When** the next `publicStatusPage` POST carries `Cookie: junk=cookie`
**Then** it is answered 429 with `Retry-After`, and the resolver is not reached

**Given** an expired or signed-out session's cookie
**When** the bucket is exhausted
**Then** the answer is the same 429

**Given** a valid operator session
**When** it makes more requests than the anonymous limit
**Then** none is rationed

**Given** every GraphQL transport the server accepts
**When** anonymous traffic arrives over it
**Then** it is bounded the same way, or the transport is refused, and a test pins which

### Story 9.3: GraphQL refuses what REST refuses — incidents

As an operator using GraphQL,
I want incidents and their updates judged by the same rules REST applies,
So that a GraphQL client cannot store an incident REST would have refused.

**Actor:** human
**Satisfies:** FR27 verification — "GraphQL refuses each input the REST schema refuses". Audit F-01, part 2 of 3.
**Files:** the `.handler.ts` of `create-incident`, `update-incident`, `transition-incident` and `post-incident-update` under `src/modules/incident/commands/`, a GraphQL refusal integration test
**Verification layer:** integration

**Acceptance Criteria:**

**Given** each rule in the incident slice's TypeBox request schemas — title and message length, the impact and status ladders, UUID ids
**When** a value breaking it reaches the matching mutation over GraphQL
**Then** it is refused as REST refuses it
**And** nothing is written and nothing is emitted

**Given** the story's investigation
**When** it lists each rule the GraphQL path did not apply
**Then** the list is recorded in the spec, and where it is empty the story closes with one refusal test per rule as the evidence

### Story 9.4: GraphQL refuses what REST refuses — maintenance

As an operator using GraphQL,
I want maintenance windows judged by the same rules REST applies,
So that a GraphQL client cannot schedule a window REST would have refused.

**Actor:** human
**Satisfies:** FR27 verification — "GraphQL refuses each input the REST schema refuses". Audit F-01, part 3 of 3.
**Files:** the `.handler.ts` of `schedule-maintenance`, `update-maintenance`, `complete-maintenance` and `delete-maintenance` under `src/modules/maintenance/commands/`, a GraphQL refusal integration test
**Verification layer:** integration

**Acceptance Criteria:**

**Given** each rule in the maintenance slice's TypeBox request schemas
**When** a value breaking it reaches the matching mutation over GraphQL
**Then** it is refused as REST refuses it
**And** nothing is written and nothing is emitted

**Given** the story's investigation
**When** it lists each rule the GraphQL path did not apply
**Then** the list is recorded in the spec, and where it is empty the story closes with one refusal test per rule as the evidence

### Story 9.5: One slug rule for organizations, at creation and lookup

As an operator,
I want an organization's slug checked when it is created or changed,
So that every organization I create has a public page that answers.

**Actor:** human
**Satisfies:** DOMAIN, Better-Auth-owned references — "Creating an organization, and changing its slug, apply the same rule". Audit F-05; Epic 3 retrospective item 24.
**Files:** `src/server/auth/auth.ts`, `src/shared/domain/slug.ts`, `src/server/auth/auth.integration.test.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** organization creation through Better Auth with a slug outside the rule — uppercase, spaces, a leading or trailing hyphen, over 120 characters
**When** it is attempted
**Then** it is refused with a 4xx and no `"organization"` row exists

**Given** slugs at each boundary — 1 character, 120 characters, hyphen-separated runs
**When** they are created
**Then** each succeeds and `/status/<slug>` answers 200

**Given** an update that changes a slug to one outside the rule
**When** it is attempted
**Then** it is refused

**Given** the rule
**When** creation and lookup apply it
**Then** both call the one function in `src/shared/domain/slug.ts`

### Story 9.6: Read service groups

As an operator's client,
I want to list my organization's service groups and read one,
So that I can show and edit groups after losing local state.

**Actor:** human
**Satisfies:** FR4; FR27 verification — "the reads a client needs to reopen everything it can edit". Audit F-03, part 1.
**Files:** `src/modules/service/queries/list-service-groups/`, `src/modules/service/queries/get-service-group/` (route, resolver, schema, graphql-schema), `src/modules/service/dtos/`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an organization with groups created in reverse of their expected order
**When** they are listed
**Then** they come back ordered by `display_order`, then `name`, then `id`, over REST and GraphQL alike

**Given** another organization's group id
**When** it is read
**Then** the answer is 404, not an empty result

**Given** an organization with no groups
**When** groups are listed
**Then** an empty collection is returned

**Given** the parity contract
**When** it runs
**Then** it compares this capability

> The list is unbounded: an organization has tens of groups. The spec records that, and pagination is decided in Epic 8 before any list becomes an external contract (audit F-14).

### Story 9.7: Read one incident with its affected services

As an operator's client,
I want to read an incident with its affected services and their per-service impact,
So that I can edit it without silently dropping services `updateIncident` would replace.

**Actor:** human
**Satisfies:** FR6; FR27 verification — "the reads a client needs to reopen everything it can edit". Audit F-03, part 2.
**Files:** `src/modules/incident/queries/get-incident/`, `src/modules/incident/dtos/` (an admin detail response)
**Verification layer:** integration

**Acceptance Criteria:**

**Given** an incident naming two services with different impacts
**When** it is read
**Then** its headline fields and `affectedServices`, each with `serviceId` and `impact`, are returned

**Given** that response
**When** it is fed back unchanged into `updateIncident`
**Then** no `incident.updated` is emitted, because nothing changed

**Given** a draft incident
**When** an operator reads it
**Then** it is returned

**Given** another organization's incident
**When** it is read
**Then** the answer is 404

**Given** the same incident read over REST and GraphQL
**When** both answer
**Then** the values are identical

### Story 9.8: Admin service lists settle ties by id

As the system,
I want the admin service list to end its order on a unique column,
So that two tied services never swap places between requests.

**Actor:** system
**Satisfies:** `AGENTS.md` — "A query whose order is part of a response ends at a unique column". Audit F-06.
**Files:** `src/modules/service/database/service.repository.ts`, its integration test
**Verification layer:** integration

**Acceptance Criteria:**

**Given** two services tied on `display_order` and `name`, created in reverse of `id` order
**When** services are listed repeatedly
**Then** they always come back in `id` order

**Given** the story's investigation
**When** it finds another admin query without a unique final sort column
**Then** each one found is recorded as its own story in its own module

### Story 9.9: Close Better Auth's pool on shutdown

As the system,
I want Better Auth's database pool closed when the application closes,
So that `api`, `worker` and the seed exit cleanly instead of being forced to.

**Actor:** system
**Satisfies:** ARCHITECTURE section 7 — "Better Auth's `pg` pool is closed by the application that opened it"; NFR29 verification — "shut down without forcing exit". Audit F-07.
**Files:** `src/server/auth/auth.ts`, `src/server/plugins/auth.ts`, `db/seeds/seed.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a built app that has served authenticated requests
**When** `app.close()` resolves
**Then** Better Auth's pool holds no connections
**And** it closed after the event bus drained

**Given** the seed
**When** it finishes
**Then** the process exits on its own, and the forced `process.exit` is removed

### Story 9.10: Worker health reports completed passes

As an operator,
I want the worker's healthcheck to fail when passes stop completing,
So that a stuck worker is reported unhealthy rather than healthy.

*Corrected after the Epic 9 retrospective (AV-5a).* The story said a stuck worker "is restarted". Plain Docker Compose marks an unhealthy container and does not restart it, and ROADMAP has no deployment target, so acting on the status belongs to whatever orchestrator a deployment uses.

**Actor:** human
**Satisfies:** ARCHITECTURE section 8 — "the check fails once completion is overdue"; NFR29 verification — "Each healthcheck fails when its process stops doing its work". Audit F-08.
**Files:** `src/worker.ts`, `src/healthcheck.ts`, `src/config/env.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a pass that never settles, injected by the test
**When** the overdue threshold passes
**Then** the healthcheck exits non-zero, although the heartbeat timer still writes

**Given** passes completing normally
**When** the healthcheck runs
**Then** it passes

**Given** one pass slower than the interval but within the threshold
**When** the healthcheck runs
**Then** it still passes

**Given** a worker that has just started
**When** its first pass has not completed yet
**Then** the check allows a grace period equal to the threshold

### Story 9.11: Every GraphQL mutation runs over GraphQL

As the system,
I want every GraphQL mutation exercised over GraphQL, with a guard that notices a new one,
So that parity is proven by behaviour rather than by matching field names.

**Actor:** system
**Satisfies:** FR27 verification — "every mutation is exercised over GraphQL"; Epic 2 VG-4; Epic 3 retrospective item 22. Audit F-09.
**Files:** `src/shared/api/graphql-mutations.integration.test.ts` (new), shared helpers in `src/shared/testing/` (part of Epic 3 retrospective item 20)
**Verification layer:** integration
**Depends on:** 9.1, 9.3, 9.4

**Acceptance Criteria:**

**Given** the merged schema's `Mutation` fields
**When** the suite runs
**Then** each has at least one success case and one meaningful refusal over GraphQL: an unauthenticated refusal, and a validation refusal where the mutation takes input

**Given** a new mutation added without a case
**When** the suite runs
**Then** it fails and names the field, because the suite compares its own registry with the schema

### Story 9.12: Public CORS headers on every answer

As a browser script on another origin,
I want every answer from the public page to carry its CORS headers,
So that I can read a 404 or 429 as well as a 200.

**Actor:** human — a browser on another origin
**Satisfies:** ARCHITECTURE section 5.4.1 — "CORS for any origin, without credentials". Audit F-12. *Should.*
**Files:** `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts`, `src/modules/status-page/public-surface-bounds.integration.test.ts`
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a cross-origin request
**When** it is answered 200, 304, 404 or 429
**Then** every answer carries the public CORS headers and exposes `ETag`

### Story 9.13: SQL debug logging never prints parameter values

As the system,
I want database debug logging to omit parameter values,
So that incident text today, and subscriber addresses from Epic 6, never reach a log.

**Actor:** system
**Satisfies:** AI.md section 4.4, PII and log handling; ARCHITECTURE section 5.6 — "Subscriber addresses never reach logs". Audit F-16. *Should; must land before Epic 6.*
**Files:** `src/shared/db/postgres.ts`
**Verification layer:** unit

**Acceptance Criteria:**

**Given** `LOG_LEVEL=debug`
**When** a parameterized query runs
**Then** the statement and the parameter count are logged through the application logger
**And** no parameter value is logged

### Story 9.14: The runtime role cannot hard-delete a service

As the system,
I want the database to refuse a service delete from the runtime role,
So that "archived, never hard-deleted" is enforced rather than remembered.

**Actor:** system
**Satisfies:** DOMAIN, Archive semantics — "v1 has no hard service delete". Audit F-17. *Should.*
**Files:** a new migration revoking `DELETE` on `services` from `watchdog_app` (never an edit to the applied grant migration), a privilege integration test
**Verification layer:** integration

**Acceptance Criteria:**

**Given** `watchdog_app`
**When** it issues `delete from services`
**Then** Postgres refuses with a permission error

**Given** archive and restore
**When** they run
**Then** both still work

## Epic 5: Automated monitoring and uptime history

Outages are detected rather than noticed. Synthetic checks run on schedule, results are stored and rolled up into 90-day history, and repeated failures propose a draft incident that a human confirms.

**FRs covered:** FR10, FR11, FR12, FR13, FR18. Also carries the monitor halves of FR4 (archive suspends monitors) and FR5 (monitor-derived state), and Epic 2's D-1.

Written 2026-10-09 from DEC-MON M1–M8 (2026-10-06) and the owner's decisions of 2026-10-09, recorded in DOMAIN (Monitor, MonitorSslWarning, Public status page), ARCHITECTURE (sections 2 and 4) and ROADMAP (Monitoring configs, Docker Compose). **Delivered after Epic 9 and before Epic 4.** Sixteen stories, after the step-4 validation split 5.8 in two. The stories run in order; each depends only on earlier ones:

- 5.1–5.7 build the `monitoring` module from configuration to a recorded result: configure, read back, store, check, record, warn.
- 5.8–5.9 find the due checks and run them on the worker's own loop.
- 5.10 feeds monitor state into service status.
- 5.11–5.12 roll results up into the public 90-day history.
- 5.13–5.14 make timeline order independent of the clock (D-1) before monitors write into drafts.
- 5.15–5.16 open drafts from breaches and reconcile the ones an event lost.

> **Constraint 1 (one module per story).** `src/worker.ts` is the composition root, not a module, so a story may wire a module's command into a worker pass, as Story 2.15 did. Stories 5.3, 5.9, 5.11 and 5.16 do this. D-1 is two stories, 5.13 and 5.14, because the admin timeline (`incident`) and the public timeline (`status-page`) each order `incident_updates` in their own SQL.
>
> **Deferred past v1 by the owner, 2026-10-09** (ARCHITECTURE section 2): `DeleteMonitorCommand`, `GetMonitorResultsQuery` and `monitor.deleted`. A monitor is disabled instead.
>
> **Epic 3 retrospective item 23** goes with the first story that adds a foreign-table read: 5.8, where the due-monitor query joins `services`. Stories 5.10 and 5.12 extend its allowlist. The unit is the table, so 5.14's new column on an already listed table needs no entry.
>
> **Deferred work picked up:** 5.2 carries the id-taking `Query` field registry (`deferred-work.md`, "Before the next id-taking GraphQL `Query` field is added"). 5.9 carries the three entries whose target is Epic 5. Each story removes the entries it closes.
>
> **Monitor event contracts** live in a new `src/shared/events/monitor.events.ts`, with their own payload types, so `service` and `incident` subscribe without importing `monitoring`. The derived-state rule (DOMAIN M1) is a pure function in `src/shared/domain/monitor-state.ts`, because both `monitoring` and `service` compute it.

### Story 5.1: Create and update a monitor

As an operator,
I want to configure HTTP(S), TCP, keyword-match and SSL-expiry monitors for a service and change them later,
So that the service is checked without anyone watching it.

**Actor:** human
**Satisfies:** FR10 verification — "Validation tests cover all check types and invalid configs"; DOMAIN, Monitor (including "Editing a monitor can move its derived state", 2026-10-09) and How monitor state is derived (M1); ARCHITECTURE section 6.5 (M6), the configure-time courtesy check
**Files:** `db/migrations/*_create_monitors.sql`, `src/modules/monitoring/index.ts`, `src/modules/monitoring/commands/create-monitor/` and `.../update-monitor/` (each: `.handler.ts`, `.route.ts`, `.resolver.ts`, `.schema.ts`, `.graphql-schema.ts`), `src/modules/monitoring/domain/` (`monitor.domain.ts`, `monitor.types.ts`, `target-safety.ts`), `src/modules/monitoring/database/monitor.repository.ts`, `src/modules/monitoring/dtos/` (`monitor.present.ts`, `monitor.response.dto.ts`, `monitor.graphql-schema.ts`), `src/shared/domain/monitor-state.ts`, `src/shared/events/monitor.events.ts`, `src/config/env.ts` (the allowed-CIDR list), `src/shared/testing/fixtures.ts` (`createMonitor`), 9.11's mutation registry and the parity contract in `src/shared/api/`, `docs/genesis/DOMAIN.md` (the bounds below)
**Verification layer:** unit (`target-safety.spec.ts`, `monitor-state.spec.ts`) and integration (`src/modules/monitoring/monitor.integration.test.ts`, `monitor-input-validation.integration.test.ts`)

**Acceptance Criteria:**

**Given** the `monitors` table is created with DOMAIN's columns, `failure_episode` included (not null, default 0), the `type` CHECK (`http`, `tcp`, `keyword`, `ssl_expiry`), `unique (id, org_id)`, and a tenant foreign key `(service_id, org_id)` to `services`
**When** the migration is applied
**Then** row level security is enabled and `FORCE`d
**And** a policy compares `org_id` to `current_setting('app.current_org_id', true)`
**And** `tenant-rls-coverage.integration.test.ts` passes

**Given** an authenticated operator and a service in their organization
**When** they create one monitor of each type with a valid configuration
**Then** each is persisted, scoped to their organization, with `consecutive_failures` 0 and `last_checked_at` null
**And** `monitor.created` is emitted for each
**And** a second organization cannot read any of them

**Given** an invalid configuration for each type: an `http` target that is not an `http` or `https` URL, a `keyword` monitor with no keyword, a `tcp` target with no port or one outside 1–65535, an `ssl_expiry` monitor without a positive whole `config.warnDays`, a `timeout_seconds` not below `interval_seconds`, and a `failure_threshold` below 1
**When** each is submitted over REST and over GraphQL
**Then** both surfaces refuse it with a 400 naming the field, because the handler applies the request schema itself (`assertMatchesSchema`) before any SQL
**And** the minimum interval and the upper bounds this story chooses are recorded in DOMAIN's Monitor table before the story merges, since DOMAIN gives none today

**Given** a target whose host resolves to a loopback, private (RFC 1918 or IPv6 unique-local), link-local (including `169.254.169.254`), unspecified or multicast address
**When** the monitor is created or its target updated
**Then** it is refused with a message naming the refusal
**And** the same target is accepted when its address falls inside a CIDR range listed in the allowed list in `src/config`, which is empty by default
**And** this is the courtesy check only; story 5.4 proves the connect-time guard

**Given** a `service_id` that does not exist, or belongs to another organization
**When** a monitor is created for it
**Then** the request is refused with a 4xx naming the service, never a masked 500 from the foreign key

**Given** an existing monitor
**When** its name, target, interval, timeout, threshold, configuration or `enabled` flag is updated
**Then** the change persists and `monitor.updated` is emitted
**And** an operator from another organization updating it affects zero rows

**Given** a monitor whose derived state is `degraded` or `failing`
**When** it is disabled, or its `failure_threshold` is changed so the derived state moves
**Then** `monitor.state_changed` is emitted with the state before and after, computed by `src/shared/domain/monitor-state.ts`
**And** an edit that leaves the derived state where it was emits no `monitor.state_changed`
**And** an edit that moves the state into `failing` increments `failure_episode`, opening a new episode
**And** no edit emits `monitor.threshold_breached`

**Given** a disabled monitor with a non-zero `consecutive_failures`
**When** it is re-enabled
**Then** `consecutive_failures` is reset to 0 and `last_checked_at` to null, so it contributes nothing until its next check
**And** `failure_episode` is not reset, so a later failure opens a new episode rather than reusing one

**Given** both mutations
**When** 9.11's registry runs
**Then** each is exercised over GraphQL and the parity contract holds for both slices

### Story 5.2: List a service's monitors

As an operator,
I want to read back every monitor configured for a service,
So that a client can reopen and edit what it configured.

**Actor:** human
**Satisfies:** FR27 verification — "the reads a client needs to reopen everything it can edit"; ARCHITECTURE section 2, the 2026-10-09 decision naming `ListMonitorsQuery` as that read; `deferred-work.md`, the id-taking `Query` field registry
**Files:** `src/modules/monitoring/queries/list-monitors/` (`.handler.ts`, `.route.ts`, `.resolver.ts`, `.schema.ts`, `.graphql-schema.ts`), `src/modules/monitoring/database/monitor.repository.ts`, `src/modules/monitoring/dtos/`, the id-taking `Query` field registry beside 9.11's mutation registry in `src/shared/api/`
**Verification layer:** integration (`src/modules/monitoring/read-monitors.integration.test.ts`)

**Acceptance Criteria:**

**Given** a service with enabled and disabled monitors of several types
**When** its monitors are listed
**Then** every one appears with its full configuration, `enabled` flag, `consecutive_failures` and `last_checked_at`
**And** they are ordered by name, then `id`, so ties settle the same way on every request

**Given** a service in another organization
**When** its monitors are listed
**Then** none appear

**Given** a malformed service id
**When** the list is requested over REST and over GraphQL
**Then** both answer 400, as REST's schema does

**Given** every GraphQL `Query` field that takes an id, this one included
**When** the registry test runs
**Then** each is exercised with a malformed id and must answer 400
**And** a new id-taking `Query` field with no case fails the build, closing the deferred-work entry

**Given** the same list over REST and GraphQL
**When** both are fetched
**Then** they are identical, through the shared presenter

### Story 5.3: Keep check results in monthly partitions

As the worker,
I want check results stored append-only in monthly partitions that I can create ahead and drop when expired,
So that raw results stay cheap to keep and are never edited.

**Actor:** system — the worker entrypoint
**Satisfies:** FR12 verification — "Migration tests verify partitioning … retention tests verify expired partitions are dropped according to `CHECK_RESULTS_RETENTION_DAYS`"; DOMAIN, CheckResult and partitioning (M4, M8); ARCHITECTURE section 6.1 (M5)
**Files:** `db/migrations/*_create_check_results.sql`, `src/modules/monitoring/commands/maintain-check-result-partitions/maintain-check-result-partitions.handler.ts`, `src/modules/monitoring/database/check-result-partition.repository.ts`, `src/worker.ts`, `src/config/env.ts` (`CHECK_RESULTS_RETENTION_DAYS`, default 30)
**Verification layer:** integration (`src/modules/monitoring/check-result-partitions.integration.test.ts`), unit for the env default

**Acceptance Criteria:**

**Given** `check_results` is created with DOMAIN's columns, partitioned by range on `checked_at` by month, primary key `(id, checked_at)`, and tenant foreign keys `(monitor_id, org_id)` to `monitors` and `(service_id, org_id)` to `services`
**When** the migration is applied
**Then** the parent has row level security enabled, `FORCE`d, and the standard policy
**And** `UPDATE` and `DELETE` are revoked from `watchdog_app`, so an attempt fails with a permission error, not a silent no-op

**Given** the two `SECURITY DEFINER` functions the migration creates, owned by `watchdog_owner` with a fixed `search_path`
**When** `watchdog_app`'s privileges are read
**Then** it holds `EXECUTE` on those two functions, and on the third that Story 5.11 adds, and nothing more of the owner's
**And** neither function runs SQL beyond the partition names it computes itself, and a retention that is not a positive number is refused

*Reconciled 2026-10-18 (Epic 5 retrospective, E1).* Story 5.11 added `check_results_retained_from()`, so `watchdog_app` holds `EXECUTE` on three functions; `check-result-partitions.integration.test.ts` pins three.

**Given** a worker maintenance pass
**When** partition maintenance runs
**Then** the current month and at least the two following months exist
**And** a second run creates nothing new

**Given** the creation function's optional start month, which the worker never passes
**When** a test passes an earlier month
**Then** the partitions from that month onward exist, so retention, rollup and uptime tests can store results in past months
**And** the function still computes every partition name itself

**Given** a partition the function created
**When** `watchdog_app` reads or inserts into it directly, bypassing `check_results`
**Then** it is refused, because the function revoked the default grants
**And** the partition has row level security enabled and `FORCE`d with the parent's policy, so `tenant-rls-coverage.integration.test.ts` passes unchanged

**Given** partitions wholly older than `CHECK_RESULTS_RETENTION_DAYS`, and one that still holds a day inside it
**When** partition maintenance runs
**Then** the expired partitions are detached and dropped, and the other is kept
**And** no row-level `DELETE` is issued

**Given** partition maintenance fails
**When** the worker pass runs its organizations and then maintenance
**Then** the failure is logged with its error and the per-organization work has already run
**And** the pass then rejects, so it does not count as completed
**And** the command runs once per pass, not per organization, since it touches no tenant rows and so needs no `withTenantTransaction`

*Reconciled 2026-10-18 (Epic 5 retrospective, E2).* Maintenance runs after the organization loop, so a rollup is written before retention can drop its rows, and a failure rejects the pass at the end (`src/worker.ts`).

### Story 5.4: HTTP and keyword checks behind the target guard

As the worker,
I want to run HTTP(S) and keyword checks that never reach an address a tenant must not probe,
So that a monitor measures a public service and cannot be turned against the worker's own network.

**Actor:** system — the worker entrypoint
**Satisfies:** FR11 verification — "Worker integration tests run checks against controlled test endpoints"; ARCHITECTURE section 6.5 (M6); section 6.0.1's timeout rule (M7)
**Files:** `src/modules/monitoring/checks/` (`http-check.ts`, `keyword-check.ts`, `guarded-connect.ts`, `check-outcome.ts`), `src/modules/monitoring/domain/target-safety.ts`, `src/shared/testing/test-endpoints.ts` (local HTTP servers, including a slow one, that later suites reuse). `checks/` holds the network adapters; the story confirms dependency-cruiser accepts the folder.
**Verification layer:** unit (`target-safety.spec.ts`) and integration (`src/modules/monitoring/http-checks.integration.test.ts`, against local test servers)

**Acceptance Criteria:**

**Given** any check in this story
**When** it runs
**Then** it returns an outcome of `success` or `failure`, its `checked_at`, latency, an error code, a truncated error message and type-specific metadata
**And** `checked_at` is stamped when the attempt starts, which DOMAIN's rollup window relies on
**And** it writes nothing; story 5.6 records outcomes

**Given** HTTP test endpoints answering 2xx, 5xx, refusing the connection, and never answering
**When** each is checked
**Then** 2xx succeeds, and the others fail with distinct error codes
**And** the silent endpoint fails with a timeout error code within the monitor's `timeout_seconds`

**Given** a keyword monitor
**When** the body contains the keyword, lacks it, or carries it only beyond the byte cap
**Then** it succeeds, fails and fails respectively
**And** at most the capped number of bytes is read

**Given** a target that resolves to a loopback, private, link-local (including `169.254.169.254`), unspecified or multicast address, including an IPv4-mapped IPv6 form
**When** it is checked
**Then** no connection is made, and the test endpoint sees no request
**And** the check fails with an error code naming the refusal, never succeeds

**Given** a hostname that resolved to a public address when configured and resolves to a private one at check time
**When** it is checked
**Then** it is refused, because the rule applies to the address actually connected to

**Given** a redirect chain
**When** a hop points at a refused address, or the chain exceeds the fixed hop limit
**Then** the check fails with an error code saying which

**Given** the test servers listen on `127.0.0.1`
**When** the suite runs
**Then** they are reachable only because the test's configuration allows `127.0.0.0/8`, and with the default empty list the same checks are refused

### Story 5.5: TCP and SSL-expiry checks

As the worker,
I want to run TCP and SSL-expiry checks under the same guard,
So that every check type ROADMAP names can be executed.

**Actor:** system — the worker entrypoint
**Satisfies:** FR11 verification — "Worker integration tests run checks against controlled test endpoints"; FR10, SSL-expiry checks; DOMAIN, "SSL-expiry checks measure availability" (2026-10-09); ARCHITECTURE section 6.5
**Files:** `src/modules/monitoring/checks/` (`tcp-check.ts`, `ssl-expiry-check.ts`), `src/shared/testing/test-endpoints.ts` (TCP and TLS servers and a test certificate authority; a dev dependency for generating certificates, if one is needed, is added with `pnpm install --lockfile-only`)
**Verification layer:** integration (`src/modules/monitoring/tcp-ssl-checks.integration.test.ts`, against local TCP and TLS servers whose CA the test trusts)

**Acceptance Criteria:**

**Given** a TCP target that accepts, refuses or never answers
**When** it is checked
**Then** it succeeds with a latency, fails with a refusal error code, or fails with a timeout error code
**And** a target refused by the guard fails without connecting, as in story 5.4

**Given** an SSL-expiry target serving a valid certificate
**When** it is checked
**Then** it succeeds
**And** the metadata carries `certificateFingerprint` (SHA-256 of the leaf), `certificateExpiresAt`, and `daysRemaining` as whole days from `checked_at`, rounded down: a certificate expiring 36 hours after the check carries 1

**Given** a valid certificate already inside its `warnDays` window
**When** it is checked
**Then** it still succeeds, because approaching expiry is not invalid

**Given** a certificate that fails trust validation, one whose hostname does not match, one that has expired, and one that is not yet valid
**When** each is checked
**Then** each fails with an error code naming which
**And** the metadata still carries the retrieved certificate's three fields

**Given** a target from which no certificate can be retrieved: refused, timed out, or not speaking TLS
**When** it is checked
**Then** it fails
**And** all three metadata fields are null, never zero

### Story 5.6: Record a check result and count consecutive failures

As the worker,
I want each outcome stored and the monitor's failure count updated in one transaction,
So that monitor state is derived from stored rows and every move of it is announced once.

**Actor:** system — the worker entrypoint
**Satisfies:** FR11 verification (results persisted); FR13 verification — "Worker tests simulate failure thresholds" (the event half; drafts arrive in 5.15); DOMAIN M1, and M2 steps 3–4; M8; DOMAIN, Monitor `failure_episode` (2026-10-09)
**Files:** `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts`, `src/modules/monitoring/database/check-result.repository.ts`, `src/modules/monitoring/database/monitor.repository.ts`, `src/shared/domain/monitor-state.ts`, `src/shared/events/monitor.events.ts`
**Verification layer:** integration (`src/modules/monitoring/record-check-result.integration.test.ts`); tests execute the command directly and run no worker pass

**Acceptance Criteria:**

**Given** a monitor and an outcome
**When** the result is recorded
**Then** in one tenant transaction a `check_results` row is appended, the monitor row is locked `for no key update`, `consecutive_failures` is reset to 0 on success or incremented on failure, and `last_checked_at` is set to the result's `checked_at`
**And** after commit `monitor.check_succeeded` or `monitor.check_failed` is emitted

**Given** a monitor with `failure_threshold` 3, never checked
**When** failure, failure, failure, success are recorded
**Then** `monitor.state_changed` is emitted at each move: none → `degraded`, `degraded` → `failing`, `failing` → `healthy`, with the before and after states
**And** `monitor.threshold_breached` is emitted once, at the third failure, carrying `failure_episode`, which was incremented in the same transaction
**And** `monitor.recovered` is emitted once, at the success
**And** a fourth failure in a row emits no further `monitor.threshold_breached` and leaves `failure_episode` alone
**And** failing again after the recovery opens the next episode

**Given** a result that leaves the derived state where it was
**When** it is recorded
**Then** no `monitor.state_changed` is emitted

**Given** two results for one monitor recorded concurrently
**When** both commit
**Then** `consecutive_failures` reflects both, because the row lock serializes them
**And** a crossing of the threshold is announced exactly once

**Given** a monitor disabled while its check was in flight
**When** the result is recorded
**Then** the row is stored and `monitor.check_succeeded` or `monitor.check_failed` is emitted
**And** `consecutive_failures`, `last_checked_at` and `failure_episode` are left unchanged, since re-enabling resets the first two
**And** no state event is emitted, since a disabled monitor contributes nothing

**Given** each monitor event
**When** it is emitted
**Then** it is in DOMAIN's catalog, and its payload carries `orgId`, `monitorId`, `serviceId` and `monitorName`, which `incident` needs to word a draft

### Story 5.7: Warn once per certificate before it expires

As the worker,
I want to warn once when a monitored certificate comes within its warning window,
So that an operator can renew it before it expires, without the warning lowering uptime or opening an incident.

**Actor:** system — the worker entrypoint
**Satisfies:** FR10 verification — "Tests verify a warning on the first qualifying observation, no repetition across subsequent checks or worker restarts, eligibility after certificate renewal, and no warning-induced failure, uptime reduction, or draft incident" (the draft clause is proven in story 5.15, once drafts exist); DOMAIN, SSL-expiry checks and MonitorSslWarning (2026-10-09)
**Files:** `db/migrations/*_create_monitor_ssl_warnings.sql`, `src/modules/monitoring/commands/record-check-result/record-check-result.handler.ts`, `src/modules/monitoring/database/monitor-ssl-warning.repository.ts`, `src/shared/events/monitor.events.ts`
**Verification layer:** integration (`src/modules/monitoring/ssl-expiry-warning.integration.test.ts`)

**Acceptance Criteria:**

**Given** `monitor_ssl_warnings` is created as DOMAIN specifies, with primary key `(org_id, monitor_id, certificate_fingerprint)` and a tenant foreign key `(monitor_id, org_id)` to `monitors`
**When** the migration is applied
**Then** row level security is enabled and `FORCE`d with the standard policy
**And** `tenant-rls-coverage.integration.test.ts` passes

**Given** an SSL-expiry monitor whose first-ever check finds a certificate inside the window
**When** the result is recorded
**Then** a marker row is inserted in the same transaction as the result
**And** after commit `monitor.ssl_expiry_warning` is emitted once, carrying the fingerprint and `certificateExpiresAt`

**Given** that warning has been given
**When** later checks see the same certificate, and when a fresh app instance records the next result, as after a worker restart
**Then** no further warning is emitted, because the marker is persisted, not held in memory

**Given** a target that alternates between two certificates, both inside the window
**When** A, B, A are observed
**Then** A warns once and B warns once

**Given** a renewed certificate, with a new fingerprint
**When** it later comes inside the window
**Then** it warns once in its own right

**Given** a certificate whose expiry is exactly `warnDays` days after `checked_at`, and one a millisecond later
**When** each is recorded
**Then** the first is inside the window and the second outside, compared as timestamps, not rounded days

**Given** a check that retrieved no certificate
**When** it is recorded
**Then** no marker is written and no warning is emitted

**Given** the warning depends on the expiry condition, not on whether the check succeeded
**When** an expired certificate, an untrusted certificate inside the window, and an untrusted certificate outside it are each recorded as failed checks
**Then** the first two each warn once and the third does not, since untrusted does not mean expiring

**Given** a certificate that warned while valid and later expires
**When** the expired check is recorded
**Then** no second warning is emitted

**Given** a check of a valid certificate that warns
**When** it is recorded
**Then** its result is still `success` and `consecutive_failures` is unchanged
**And** no `monitor.state_changed` or `monitor.threshold_breached` follows
**And** dropping the partition that held the warned result does not make the certificate warn again

**Given** the warning event
**When** it is emitted
**Then** it reaches in-process handlers only; email delivery (Epic 6) and realtime transport (Epic 4) are outside this story

### Story 5.8: Find and run the checks that are due

As the worker,
I want each organization's due monitors found and checked, capped and bounded by timeouts,
So that every monitor is checked on its interval and archiving a service suspends its monitors.

**Actor:** system — the worker entrypoint
**Satisfies:** FR11 verification — "The `worker` entrypoint executes checks on configured intervals and persists results … against controlled test endpoints"; ARCHITECTURE section 6.0.1 (M7); the epic's FR4 note (archive suspends monitors); Epic 3 retrospective item 23
**Files:** `src/shared/db/foreign-table-allowlist.spec.ts`, `src/modules/monitoring/commands/run-due-monitor-checks/run-due-monitor-checks.handler.ts`, `src/modules/monitoring/database/monitor.repository.ts` (the due query), `src/config/env.ts` (the concurrency cap), `src/shared/testing/` (the test endpoints from story 5.4)
**Verification layer:** unit (the allowlist) and integration (`src/modules/monitoring/due-monitors.integration.test.ts`); tests execute `RunDueMonitorChecksCommand` for their own organization and run no worker loop

**Acceptance Criteria:**

**Given** the foreign-table allowlist test, added before the due query
**When** it reads every repository's SQL
**Then** each module may name its own tables and only the foreign tables listed for it: today's reads by `service` and `status-page`, Better Auth's tables where already read, and `monitoring` → `services` for this story
**And** the unit is the table, so a new column on a listed table needs no change
**And** an unlisted foreign table fails the build naming the module, the table and the file, which a deliberately unlisted read proves

**Given** monitors that are enabled and due, enabled and not yet due, never checked, and disabled
**When** the command runs for their organization
**Then** exactly the due and the never-checked monitors are checked, each executed by stories 5.4–5.5 and recorded through `RecordCheckResultCommand` under the organization's tenant context

**Given** a service with enabled monitors
**When** it is archived
**Then** its monitors are no longer checked, and the monitor rows are not written to
**And** when it is restored, its enabled monitors are checked again when next due and its disabled ones stay off

**Given** more due monitors than the concurrency cap, against a slow endpoint
**When** the command runs
**Then** no more than the cap are in flight at once

**Given** one check that times out among others
**When** the command runs
**Then** it is recorded as a failure with the timeout error code, and the others complete

### Story 5.9: Run checks on the worker's own loop

As the worker,
I want checks on a loop of their own that reports its health and shuts down cleanly,
So that slow targets never delay maintenance transitions, and a stuck loop or a deploy never loses a result.

**Actor:** system — the worker entrypoint
**Satisfies:** ARCHITECTURE section 6.0.1 (M7, the loop's three rules), section 4 (shutdown) and section 8 (per-loop health); ROADMAP, Docker Compose verification — "Each healthcheck fails when its process stops doing its work … `api` and `worker` stop taking new work, finish in-flight work and event handlers, and close their database pools before terminating"; `deferred-work.md`, the three entries targeting Epic 5
**Files:** `src/worker.ts`, `src/worker-health.ts`, `src/config/env.ts` (`WORKER_MONITOR_INTERVAL_MS` and the overdue cross-check)
**Verification layer:** unit (env) and integration (`src/worker-lifecycle.integration.test.ts`)

**Acceptance Criteria:**

**Given** the worker
**When** it starts
**Then** it runs story 5.8's command for each organization on a loop separate from the maintenance pass, every `WORKER_MONITOR_INTERVAL_MS`

**Given** a tick still running when the next is due
**When** the interval fires
**Then** it logs and skips; the loop never overlaps itself, and a monitor already queued or running is not queued again
**And** a tenant-discovery failure costs one tick, and a tick in which every organization failed rejects and does not count as a completed pass

*Reconciled 2026-10-18 (Epic 5 retrospective, DR-1).* A tick queues checks and does not wait for them, so they outlive it. "Never overlaps itself" holds for ticks, and for a monitor through a process-wide registry (ARCHITECTURE 6.0.1).

**Given** the monitor loop is overdue while the maintenance loop completes
**When** the healthcheck runs
**Then** it fails, because health is recorded per loop name
**And** a `WORKER_PASS_OVERDUE_MS` not above `WORKER_MONITOR_INTERVAL_MS` fails boot naming both

**Given** a seam that starts the real worker scoped to the test's own organizations
**When** a test starts it and runs the healthcheck
**Then** the healthcheck passes once a pass completes, closing the Story 9.10 entry

**Given** the real worker with a check in flight
**When** it receives SIGTERM
**Then** it stops taking new ticks, finishes the check and records its result, drains event handlers and closes its pools before the process ends by itself
**And** this closes the retrospective item 2 entry; the api's shutdown test (Story 9.9 entry, Epic 8) stays open

**Given** a heartbeat write that fails
**When** it is logged
**Then** the log carries the error's message under `err`, not an empty `error` object

**Given** the integration suite
**When** it starts the worker
**Then** it is scoped to its own organizations; nothing runs an unscoped pass

### Story 5.10: Monitor state moves service status

As the system,
I want a service's status recomputed from what its monitors say,
So that a visitor sees an outage a monitor detects before anyone declares it.

**Actor:** system — an event handler in the `service` module
**Satisfies:** FR5 verification — "monitor-derived state", the fourth condition Story 2.18 could not construct, verified by a service listing the status its monitor state resolves to; DOMAIN M1 and M3
**Files:** `src/modules/service/commands/recompute-service-status/recompute-service-status.event-handler.ts`, `src/modules/service/database/service-status.repository.ts`, `src/shared/domain/monitor-state.ts`, `src/shared/db/foreign-table-allowlist.spec.ts` (`service` → `monitors`)
**Verification layer:** unit (`monitor-state.spec.ts`) and integration (`recompute-service-status.integration.test.ts`, `serve-service-status.integration.test.ts`)

**Acceptance Criteria:**

**Given** the recomputation handler
**When** `monitor.state_changed` is emitted
**Then** it recomputes the organization's live services
**And** `monitor.check_succeeded` and `monitor.check_failed` trigger nothing, as M3 decides

**Given** a service's monitors
**When** its `monitorState` is derived from their rows
**Then** each monitor is `healthy` at 0 failures, `degraded` below its threshold, `failing` at or above it
**And** disabled and never-checked monitors contribute nothing
**And** the service takes the worst of the rest, or null when none contribute

**Given** a service with no override, incident or maintenance, and one monitor
**When** the monitor is `failing`, `degraded` or `healthy`
**Then** the service lists as `major_outage`, `degraded` or `operational` over REST and GraphQL alike

**Given** a failing monitor and a manual override, or a failing monitor and a `minor` incident
**When** status is resolved
**Then** the override wins outright, and otherwise the worse input wins, the worst-of rule

**Given** a failing monitor
**When** it is disabled
**Then** the service returns to `operational`

**Given** a `monitor.state_changed` that no handler received
**When** the organization's reconciliation runs
**Then** the status is corrected, because the state is read from rows, never from the event

**Given** an archived service with a failing monitor
**When** recomputation runs
**Then** the service is skipped

### Story 5.11: Refresh daily uptime rollups

As the worker,
I want each day's check results reduced to one row per service,
So that 90-day history is read from rollups rather than raw results.

**Actor:** system — the worker entrypoint
**Satisfies:** FR12 verification — "rollup tests validate daily aggregates"; FR18 verification — "Rollup tests" (the rollup half); DOMAIN, UptimeRollup (including "Which days a refresh covers", 2026-10-09), UptimeRollupProgress, and partitioning (`ROLLUP_RETENTION_DAYS`); ARCHITECTURE section 6.1 (refresh before partition maintenance)
**Files:** `db/migrations/*_create_uptime_rollups.sql` (also creates `uptime_rollup_progress`), `src/modules/monitoring/commands/refresh-uptime-rollups/refresh-uptime-rollups.handler.ts`, `src/modules/monitoring/database/uptime-rollup.repository.ts`, `src/shared/events/monitor.events.ts` (`uptime.rollup_refreshed`), `src/worker.ts`, `src/config/env.ts` (`ROLLUP_RETENTION_DAYS`, default 400)
**Verification layer:** integration (`src/modules/monitoring/uptime-rollups.integration.test.ts`)

**Acceptance Criteria:**

**Given** `uptime_rollups` is created as DOMAIN specifies, primary key `(org_id, service_id, day)`, `worst_status` CHECK on the three-level scale, and a tenant foreign key `(service_id, org_id)` to `services`
**When** the migration is applied, together with `uptime_rollup_progress` as DOMAIN specifies
**Then** both tables have row level security enabled and `FORCE`d with the standard policy
**And** `tenant-rls-coverage.integration.test.ts` passes

**Given** a day of results for a service
**When** rollups are refreshed
**Then** the row carries the totals, `uptime_ratio` as successful over total, `avg_latency_ms` over successes only, null when there were none, and `worst_status` of `operational` with no failures, `degraded` with some and `major_outage` with all

**Given** a day with no results
**When** rollups are refreshed
**Then** no row is written for it

**Given** a refresh already run
**When** it runs again with no new results
**Then** no row changes, `updated_at` included, because an unchanged day's aggregates leave its row alone

**Given** a result checked just before midnight UTC and recorded just after
**When** the next pass refreshes today and yesterday
**Then** it is counted in yesterday's row

**Given** results grouped into days
**When** they straddle midnight in a non-UTC session time zone
**Then** they are grouped by UTC date, as DOMAIN decides

**Given** an organization whose `refreshed_through` is several days behind, as after a worker outage, with those days' raw results still retained
**When** the next pass runs
**Then** every closed day after it is refreshed, oldest first, up to yesterday, and `refreshed_through` advances to yesterday
**And** with no progress row, catch-up starts at the organization's oldest retained result

**Given** a pass in which retention is about to drop a partition holding a day not yet rolled up
**When** the pass runs
**Then** catch-up runs before partition maintenance, so the day is rolled up first
**And** a day already dropped before it could be rolled up is logged as a lost range, and no row is written for it

**Given** two organizations
**When** the worker refreshes
**Then** each refresh runs under its own organization's tenant transaction, and neither's rollups include the other's results

**Given** SSL-expiry results that warned, one a valid certificate's success and one an expired certificate's failure
**When** their day is rolled up
**Then** each counts as its own outcome, and the warning itself changes nothing in the day's aggregates

**Given** rollups older than `ROLLUP_RETENTION_DAYS`, and raw partitions dropped by retention
**When** the worker runs
**Then** the old rollups are pruned and `uptime.rollup_refreshed` is emitted
**And** rollups whose raw results were dropped remain

### Story 5.12: Fill the 90-day uptime in the public payload

As an integrator,
I want each public service's last 90 days of uptime in the status payload,
So that I can draw uptime bars without credentials or date arithmetic.

**Actor:** human — an integrator, not a browser
**Satisfies:** FR18 verification — "public-page tests verify 90-day output shape"; FR17 verification — "E2E tests cover the public route by org slug", for the uptime field; DOMAIN, Public status page (including the 2026-10-09 per-service rule)
**Files:** `src/modules/status-page/database/public-status.repository.ts`, `src/modules/status-page/queries/get-public-status-page/get-public-status-page.handler.ts`, `src/modules/status-page/dtos/public-status-page.present.ts`, `src/modules/status-page/dtos/public-status-page.contract.spec.ts`, `src/shared/db/foreign-table-allowlist.spec.ts` (`status-page` → `uptime_rollups`), `tests/status-page/public-status.feature` and `.steps.ts`
**Verification layer:** integration (`src/modules/status-page/public-uptime.integration.test.ts`) and E2E

**Acceptance Criteria:**

**Given** a visible service with rollups on some days of the window
**When** the payload is fetched
**Then** it appears in `uptime.services` with exactly 90 days, oldest first, ending today (UTC)
**And** a day with no rollup carries `uptimeRatio: null` and `worstStatus: null`
**And** `uptimeRatio` and `worstStatus` match the rollup on the other days

**Given** a rollup dated 89 days ago and one dated 90 days ago
**When** the payload is fetched
**Then** the first is inside the window and the second is not

**Given** a visible service with no rollup in the window
**When** the payload is fetched
**Then** it is absent from `uptime.services` and still present in the services list

**Given** a non-public or archived service with rollups
**When** the payload is fetched
**Then** it appears in neither list

**Given** no rollups at all
**When** the payload is fetched
**Then** `uptime.services` is `[]`, unchanged from Epic 3's contract

**Given** several services in `uptime.services`
**When** the payload is fetched
**Then** they are in the services list's order, ending at `id`

**Given** a rollup changes between two fetches
**When** the second is conditional on the first's ETag
**Then** it is not answered 304, and the uptime read joins the page's single repeatable-read snapshot

**Given** the same payload over REST and GraphQL
**When** both are fetched
**Then** they are identical, and the Cucumber scenario asserts the 90-day shape through the public route

### Story 5.13: Order the admin timeline by sequence, not the clock

As the system,
I want an incident's timeline ordered by when entries were written, not by the clock,
So that an operator never sees a later update sorted before an earlier one when the clock steps back.

**Actor:** system
**Satisfies:** FR7 verification — "API tests prove updates appear in timeline order"; Epic 2 retrospective D-1, revisited here because monitors now write into drafts; AGENTS.md, the clock-skew pitfall
**Files:** `db/migrations/*_incident_updates_sequence.sql`, `src/modules/incident/database/incident.repository.ts`, `src/modules/incident/domain/incident-timeline.ts`
**Verification layer:** integration (`src/modules/incident/` timeline suites)

**Acceptance Criteria:**

**Given** existing timeline entries
**When** the migration adds a sequence column
**Then** existing rows are numbered in their current `(created_at, id)` order and new rows take the next value at insert
**And** the migration runs as the owner, so the revoked `UPDATE` stays revoked for `watchdog_app`

**Given** entries written under the incident's row lock
**When** the admin timeline is read
**Then** it is ordered by the sequence, which follows the lock rather than the clock
**And** a test that writes an entry with an earlier `created_at` after a later one still reads it second

**Given** the incident timeline suites
**When** they run on a machine whose clock steps back
**Then** none depends on `created_at` for order

### Story 5.14: Order the public timeline by the same sequence

As an integrator,
I want the public timeline in the same order as the admin one,
So that the two never disagree about what happened first.

**Actor:** human — an integrator
**Satisfies:** FR7 verification — "updates appear in timeline order", on the public surface; DOMAIN, Public status page ("oldest first")
**Files:** `src/modules/status-page/database/public-status.repository.ts`. The allowlist needs no change: `incident_updates` is already listed, and its unit is the table
**Verification layer:** integration (`src/modules/status-page/` suites)

**Acceptance Criteria:**

**Given** an incident whose entries' `created_at` and write order disagree
**When** the public payload is fetched
**Then** its timeline follows the sequence column, oldest first, as story 5.13's admin timeline does
**And** draft-era entries are still left off

### Story 5.15: Open a draft when a monitor breaches its threshold

As the system,
I want a draft incident proposed when a monitor fails too many times in a row,
So that an operator confirms or dismisses a real outage rather than discovering it late.

**Actor:** system — an event handler in the `incident` module
**Satisfies:** FR13 verification — "Worker tests simulate failure thresholds and assert draft incident creation only"; DOMAIN M2 step 5, the deduplication invariant, Incident (draft rules), and one proposal per failure episode (2026-10-09)
**Files:** `db/migrations/*_incidents_monitor_origin.sql`, `src/modules/incident/commands/create-draft-from-monitor/` (`create-draft-from-monitor.handler.ts`, `create-draft-from-monitor.event-handler.ts`), `src/modules/incident/database/incident.repository.ts`, `src/modules/incident/domain/incident.domain.ts`, `src/shared/events/incident.events.ts` (`incident.draft_created`)
**Verification layer:** integration (`src/modules/incident/monitor-draft.integration.test.ts`)

**Acceptance Criteria:**

**Given** the existing `incidents.origin_monitor_id` column
**When** the migration adds a tenant foreign key `(origin_monitor_id, org_id)` to `monitors`, `on delete set null (origin_monitor_id)`, the nullable `origin_failure_episode` column, and the unique index `incidents_monitor_episode_uk` that DOMAIN specifies
**Then** `tenant-rls-coverage.integration.test.ts` passes

**Given** `monitor.threshold_breached` for a monitor with no open draft
**When** the handler runs
**Then** one incident is created: status `draft`, `source: monitoring`, `origin_monitor_id` and `origin_failure_episode` set from the event, impact `critical`, the monitor's service affected at `critical`, titled `Monitor failure: <monitor name>`, with no creating user
**And** a timeline entry is appended at status `draft` in the same transaction
**And** `incident.draft_created` is emitted, and neither `incident.created` nor `incident.update_posted`

**Given** a second breach of the same monitor while its draft is open, or two delivered concurrently
**When** the handler runs
**Then** no second draft is created, because the partial unique index holds and a unique violation means "already exists"
**And** no second `incident.draft_created` is emitted

**Given** the monitor originated a confirmed incident that is not yet resolved
**When** it breaches again
**Then** no draft is created

**Given** a draft dismissed while its monitor is still failing
**When** the same episode is proposed again
**Then** no draft is created, because `incidents_monitor_episode_uk` holds one incident per monitor per episode
**And** the monitor keeps being checked and its state still reaches the service's status

**Given** that monitor recovers and later breaches again
**When** the new episode's breach arrives
**Then** a new draft is created for it

**Given** a draft
**When** the public payload and the service's status are read
**Then** the draft is not on the public page
**And** it adds nothing to the service's status beyond what the monitor's own state already says, since a draft is excluded from status inputs

**Given** a monitor with `failure_threshold` 3, checked by the test through `RecordCheckResultCommand` on the command bus
**When** three failing results are recorded, then a fourth
**Then** exactly one draft exists, created by this story's handler from the breach
**And** nothing else happens to it: no confirm, no dismiss, no second draft, which is FR13's "draft incident creation only"

**Given** an SSL-expiry monitor whose valid certificate warns
**When** the warning is emitted
**Then** no draft is created, closing the FR10 clause story 5.7 could not yet prove

**Given** `monitor.recovered` for the draft's monitor
**When** it is emitted
**Then** the draft is unchanged: creation only, no automatic confirm or dismiss

**Given** a monitor-born draft
**When** a human confirms it (`draft → investigating`) or dismisses it (`draft → resolved`) with `TransitionIncidentCommand`
**Then** confirming emits `incident.confirmed` and dismissing emits `incident.dismissed` only

**Given** the handler
**When** it subscribes
**Then** it reaches `monitor.threshold_breached` through `src/shared/events/`, never by importing `monitoring`

### Story 5.16: Reconcile missed drafts each pass

As the worker,
I want each pass to open the drafts a lost event never opened,
So that a breach is proposed even if the handler failed.

**Actor:** system — the worker entrypoint
**Satisfies:** FR13 verification — "assert draft incident creation only"; DOMAIN M2 step 6, Monitor ("an edit never emits `monitor.threshold_breached`"), and one proposal per failure episode (2026-10-09)
**Files:** `src/modules/monitoring/queries/list-monitors-at-threshold/list-monitors-at-threshold.handler.ts`, `src/modules/monitoring/database/monitor.repository.ts`, `src/worker.ts`
**Verification layer:** integration (`src/modules/monitoring/draft-reconciliation.integration.test.ts`)

**Acceptance Criteria:**

**Given** the `monitoring` query
**When** it selects monitors
**Then** it returns the enabled monitors at or above their threshold on unarchived services, each with its current `failure_episode`, and reads only `monitors` and `services`
**And** the incident-side conditions (no open draft, no unresolved incident it originated, no incident for the episode) are applied by story 5.15's command, so `monitoring` never reads `incidents`

**Given** such a monitor with no draft, because the draft handler failed
**When** the worker pass runs for its organization
**Then** one draft is created through story 5.15's command, for the monitor's current episode
**And** a second pass creates nothing

**Given** an edit that lowered a monitor's threshold so it is now `failing`, which emits no `monitor.threshold_breached`
**When** the next pass runs
**Then** one draft is created for the episode the edit opened

**Given** an operator dismissed the draft while the monitor is still failing
**When** the next pass runs, and every pass after it until the monitor leaves `failing`
**Then** no draft is reopened, so the human decision survives the worker
**And** the monitor is still checked on schedule

**Given** an operator confirmed the draft and later resolved the incident while the monitor is still failing
**When** the next passes run
**Then** no draft is reopened for that episode either

**Given** monitors below their threshold, disabled, or on archived services
**When** the pass runs
**Then** no draft is created for them

**Given** the worker
**When** it reconciles
**Then** it calls the `monitoring` query and the `incident` command through the buses, importing their factories as Constraint 1 allows the composition root
**And** one organization's failure is logged and does not stop the others

*Reconciled 2026-10-18 (Epic 5 retrospective, E3).* For this step `src/worker.ts` imports the two factories (`listMonitorsAtThresholdQuery`, `createDraftFromMonitorCommand`) and runs them through the buses; "imports neither module" was stricter than Constraint 1, which lets the composition root import factories.

**Given** the integration suite
**When** it runs passes
**Then** each is scoped with `{ orgIds }`

## Epic 4: Live updates

Public and admin surfaces update without a refresh: SSE for public pages, GraphQL subscriptions for admin, both fed across processes by the Postgres LISTEN/NOTIFY backplane.

**FRs covered:** FR14, FR15, FR16. Also closes the four `deferred-work.md` entries from story 9.12 whose target is Epic 4.

Written 2026-10-18 from DOMAIN (Canonical event catalog, LISTEN/NOTIFY channel sketch, Public status page), ARCHITECTURE sections 4, 5.1–5.5, 7.1 and 9, and the owner's four decisions of 2026-10-18, recorded in ARCHITECTURE sections 5.4, 5.4.1, 5.5 and 9 before these stories were written:

- **The public stream sends the page.** An SSE client receives the document `/status/:orgSlug` returns, when the stream opens and whenever it changes. A whitelisted event triggers a recomposition; only a changed page is sent. This applies DOMAIN's whole Public status page rule by construction, rather than through a second, event-shaped copy of it.
- **Streams are capped and expire.** At most 10 per client IP and 1,000 per api process, each closed after an hour, all three configurable.
- **A subscription closes within a minute of losing access.** The session and membership are re-checked every 60 s. *Amended by story 4.8:* membership is re-checked for the organization the subscription was admitted for, not the session's current active organization (spec 4.8, triage #10).
- **The cross-process proof runs in CI,** in a new `compose` job that boots the built image.

Nine stories, in order; each depends only on earlier ones:

- 4.1–4.2 finish the existing public route before a second one inherits its behaviour.
- 4.3–4.4 build the backplane: every process bridges events to `NOTIFY`, and the api listens and fans out per organization.
- 4.5–4.6 open the public stream and push the page.
- 4.7–4.8 open the admin subscription and close it when access is lost.
- 4.9 proves a worker-originated change reaches both kinds of client across processes, under Compose.

> **Constraint 1 (one module per story).** The bridge, the listener and the realtime hub are infrastructure, not a module: they read no tenant table and decide nothing about the domain, as the event bus does not. They live in `src/shared/realtime/`, so a module may subscribe to the hub without importing `src/server`. The admin subscription relays the hub's signals and reads no tenant data, so it lives in `src/server/realtime/` beside the GraphQL wiring. The public stream is a `status-page` slice, because it composes that module's page.
>
> **The contract specs need two deliberate exemptions.** `api-surface-parity.spec.ts` requires every slice with a `.route.ts` to have a `.resolver.ts`. The public stream is REST only, because ARCHITECTURE 5.5 makes GraphQL subscriptions admin-only, so story 4.5 adds a named exemption for that one slice, and ARCHITECTURE 7.1 records it. `authenticated-surface.spec.ts` reads only `src/modules`, so story 4.7 extends it to read the subscription's resolver; otherwise the one operation that most needs the check would escape it.
>
> **Event names on the wire.** The in-process bus types events as `<prefix>/<name>` (`incident/created`); DOMAIN's catalog and the `NOTIFY` payload use `<prefix>.<name>` (`incident.created`). The bridge translates; nothing past it sees the slash form.
>
> **Deferred work.** Story 4.1 closes the three CORS entries from 9.12 (router-answered misses, malformed percent-encoding, `Retry-After`), and 4.2 the HEAD 304 entry. The 5.13 note on `sequence` as a cursor is retargeted to Epic 6: Epic 4 keeps no cursor, since a stream starts from the current page and a subscription carries signals only (ARCHITECTURE 5.4). The cursor it describes is the notification pass's (ARCHITECTURE 5.6).
>
> **Constraint 10, the premise behind not making delivery durable.** `NOTIFY` is a signal (ARCHITECTURE 5.1). A lost one leaves a stream on its last page until the next public change in that organization, or at most `PUBLIC_STREAM_MAX_LIFETIME_SECONDS` (3,600 s by default), when the reconnect sends the current page. An admin client that missed a signal sees the change on its next read, or after the `resync` story 4.4 sends when the listener reconnects.

### Story 4.1: Every answer under /status/ carries the public headers

As an integrator calling the public page from a browser on another origin,
I want every answer under `/status/` to carry the page's CORS headers, misses and refusals included,
So that my script can read why a request failed instead of seeing an opaque network error.

**Actor:** human — an integrator
**Satisfies:** ARCHITECTURE section 5.4.1, CORS for any origin, without credentials; `deferred-work.md`, story 9.12's router-404, malformed-encoding and `Retry-After` entries
**Files:** `src/server/build-app.ts` (Fastify's `frameworkErrors`), `src/server/framework-errors.ts`, `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts` (`publicHeaders`), `docs/genesis/ARCHITECTURE.md` section 5.4.1 (`Retry-After` exposed; the headers go on every answer under `/status/`)
**Verification layer:** integration (`src/modules/status-page/` public-route suites)

**Acceptance Criteria:**

**Given** a path under `/status/` that no route matches, such as `/status/x/` or `/status/a/b`
**When** it is requested
**Then** the router's 404 carries `access-control-allow-origin: *` and `cross-origin-resource-policy: cross-origin`, as the route's own miss does
**And** no path outside `/status/` gains these headers

**Given** a malformed percent-encoding under `/status/`, such as `/status/%E0`
**When** it is requested
**Then** the 400 carries the same public headers

**Given** a client over the public rate limit
**When** it is refused with 429
**Then** `access-control-expose-headers` names `Retry-After` as well as `ETag`, so a cross-origin script can read when to retry
**And** ARCHITECTURE 5.4.1 records both, and that the headers go on every answer under `/status/`, before the story merges

**Given** each new case
**When** its fix is reverted
**Then** its test fails, and the spec's Implementation Notes record that it did (Constraint 11)

*Amended during implementation:* the router's misses are answered by catch-all routes, `/status` and `/status/*`, in `get-public-status-page.public.route.ts`, not by a not-found handler. Fastify wires the last-set not-found handler into its router as the app-wide bad-URL handler and does not catch what it throws, so the first pass crashed the api on `PROPFIND /api/%E0`. A malformed URL under `/status` gets a plain 400 whose message is the fixed string `Bad Request`, so no path is echoed (spec 4.1, loopback 1 and triage #1).

### Story 4.2: HEAD revalidation answers 304

As an integrator revalidating the public page with `HEAD`,
I want a matching `If-None-Match` to answer 304,
So that a cheap check does not fail with a 500.

**Actor:** human — an integrator
**Satisfies:** ARCHITECTURE section 5.4.1, cache validators ("a matching `If-None-Match` answers 304 with no body"); `deferred-work.md`, story 9.12's HEAD entry
**Files:** `src/modules/status-page/queries/get-public-status-page/get-public-status-page.public.route.ts`
**Verification layer:** integration (`src/modules/status-page/` public-route suites)

**Acceptance Criteria:**

**Given** a `GET /status/:orgSlug` that returned an `ETag`
**When** `HEAD` is sent with that tag in `If-None-Match`
**Then** it answers 304 with no body and no `Content-Length`, and carries the public headers
**And** with a non-matching tag it answers 200 with the `GET`'s headers and no body

**Given** the fix
**When** it is reverted
**Then** the `HEAD` test answers 500 again, and the spec records that it did (Constraint 11)

### Story 4.3: Bridge domain events to NOTIFY

As the system,
I want each process to signal the events DOMAIN marks for bridging on the `watchdog_events` channel,
So that a change made in one process can reach clients connected to another.

**Actor:** system — an event handler registered in every app instance, so the `api` and the `worker` both bridge
**Satisfies:** FR16 verification — "Cross-process fanout works between `api` and `worker` using Postgres `LISTEN/NOTIFY`", the sending half; DOMAIN, Canonical event catalog ("Bridge to LISTEN/NOTIFY") and LISTEN/NOTIFY channel sketch; ARCHITECTURE sections 5.1–5.3
**Files:** `src/shared/realtime/notify-bridge.ts`, `src/shared/realtime/realtime-event.ts` (the payload type, the bridged-name set and the slash-to-dot name mapping), the app wiring that registers the handler (`src/shared/cqrs/` or `src/server/di/`), `src/shared/testing/notifications.ts` (a helper that listens on `watchdog_events` and filters by organization, reused by 4.4 and 4.9), `docs/genesis/DOMAIN.md` (the LISTEN/NOTIFY channel sketch, if this story fixes how `aggregateType` and `aggregateId` are read for monitor and uptime events)
**Verification layer:** unit (`realtime-event.spec.ts`) and integration (`src/shared/realtime/notify-bridge.integration.test.ts`)

**Acceptance Criteria:**

**Given** the bridged set
**When** the unit test compares it with DOMAIN's catalog
**Then** it holds exactly the events ARCHITECTURE 5.3 lists: every event the catalog marks "Yes", plus `uptime.rollup_refreshed`
**And** it holds none marked "No", and of the four marked "Optional" only `uptime.rollup_refreshed`, so `monitor.check_succeeded`, `monitor.check_failed` and `monitor.state_changed` are not bridged
**And** every bridged name maps to an event the code emits, so a renamed event fails the test rather than silently stopping

**Given** a test connection listening on `watchdog_events`
**When** a command commits and emits a bridged event, for example `incident/created`
**Then** one notification arrives carrying exactly `{ eventName: 'incident.created', orgId, aggregateType: 'incident', aggregateId, occurredAt, version: 1 }`
**And** `aggregateId` is the event's own id (`id`, or `monitorId` for monitor events); for `uptime.rollup_refreshed`, which names no aggregate, the story records what it carries in DOMAIN's channel sketch
**And** no title, message, name, slug, address or other field of the event's payload is sent

**Given** an event that is not bridged, such as `monitor/created` or `monitor/check_failed`
**When** it is emitted
**Then** no notification is sent

**Given** the database refuses the `pg_notify`
**When** the handler runs
**Then** the failure is logged through the bus's `onHandlerError`, the emitting command's response is unchanged, and no other handler is skipped (ARCHITECTURE 5.1)

**Given** a command that fails and rolls back
**When** it ends
**Then** no notification is sent, because events are emitted only after commit

**Given** the integration suite
**When** the test listens
**Then** it filters notifications by its own organization, since concurrent files emit on the same channel

### Story 4.4: Listen in the api and fan out per organization

As the system,
I want the api to listen on `watchdog_events` and hand each signal to the subscribers of its organization,
So that streams and subscriptions in the api see changes made in any process.

**Actor:** system — the api's realtime hub
**Satisfies:** FR16 verification, the receiving half; ARCHITECTURE section 4 (the `api` runs the `LISTEN` subscriber for client fanout), 5.4 (the subscriber sketch and the re-listen rule of 2026-10-18), and the shutdown rule
**Files:** `src/shared/realtime/realtime-hub.ts` (per-organization subscribe and publish, public and admin channels), `src/shared/realtime/event-visibility.ts` (the public whitelist), `src/shared/realtime/notify-listener.ts`, `src/api.ts` or the plugin `src/api.ts` enables, so the `worker` never listens; `tests/support/server.ts` if the E2E app must listen too
**Verification layer:** unit (`event-visibility.spec.ts`, `realtime-hub.spec.ts`) and integration (`src/shared/realtime/notify-listener.integration.test.ts`)

**Acceptance Criteria:**

**Given** the public whitelist
**When** the unit test compares it with DOMAIN's catalog
**Then** it holds exactly the events the catalog marks "Public" or "Public, draft-gated", as ARCHITECTURE 5.4's `PUBLIC_EVENT_NAMES` does
**And** `service.manual_override_*`, `incident.draft_created`, `incident.state_changed`, `incident.dismissed` and every monitor and uptime event are absent

**Given** an api with subscribers for two organizations
**When** a notification for the first arrives, sent from a different connection than the api's own
**Then** the first organization's admin subscribers receive it, and its public subscribers receive it only if its name is whitelisted
**And** the second organization's subscribers receive nothing

**Given** a notification that is not JSON, has a `version` other than 1, names an event outside the bridged set, or carries an `orgId` that fails `assertValidBetterAuthOrgId`
**When** it arrives
**Then** it is dropped and logged at `warn`, and later notifications are still delivered
**And** a subscriber that throws does not stop delivery to the others

**Given** the `LISTEN` connection is lost and re-established
**When** it is listening again
**Then** every subscriber is sent a `resync` signal, because notifications sent while it was down are gone (ARCHITECTURE 5.4)

**Given** the api's own command emits a bridged event
**When** it is delivered
**Then** subscribers receive it once, through `LISTEN`, and never a second time through the in-process bus

**Given** the worker entrypoint
**When** it starts
**Then** it opens no `LISTEN` connection, since Epic 4 gives the worker nothing to react to (ARCHITECTURE section 4, "when needed")

**Given** the app is closed
**When** `app.close()` resolves
**Then** the listener has unlistened and its connection is released before the pool closes

### Story 4.5: Open a public status stream

As an integrator,
I want to open `/status/:orgSlug/events` and receive the organization's current public page,
So that I render it at once and keep a connection that later pushes arrive on.

**Actor:** human — an integrator
**Satisfies:** FR14 verification — "E2E tests assert SSE delivery after domain events", the stream it is delivered on; ARCHITECTURE sections 5.4, 5.4.1 (the four bounds and the three stream bounds of 2026-10-18) and 5.5; DOMAIN, Public status page
**Files:** `src/modules/status-page/queries/open-public-status-stream/` (`open-public-status-stream.public.route.ts`, `.handler.ts`), `src/config/env.ts` (`PUBLIC_STREAM_MAX_PER_IP`, `PUBLIC_STREAM_MAX_TOTAL`, `PUBLIC_STREAM_MAX_LIFETIME_SECONDS`, a heartbeat interval), `.env.example`, `src/shared/api/contract/authenticated-surface.spec.ts` (`PUBLIC_BY_DESIGN` gains `GET /status/:orgSlug/events` and its `OPTIONS`), `src/shared/api/contract/api-surface-parity.spec.ts` (a named, REST-only exemption for this slice), `docs/genesis/ARCHITECTURE.md` section 7.1 (that exemption)
**Verification layer:** integration (`src/modules/status-page/public-status-stream.integration.test.ts`)

**Acceptance Criteria:**

**Given** a valid slug
**When** the stream is opened
**Then** it answers 200 with `content-type: text/event-stream`, `cache-control: no-store`, and the public headers (`access-control-allow-origin: *`, no credentials, `cross-origin-resource-policy: cross-origin`)
**And** its first event carries the same document `GET /status/:orgSlug` returns at that moment, with that page's `ETag` as the SSE `id`
**And** a heartbeat comment is written at the configured interval while nothing else is

**Given** an unknown slug, an invalid one, or one over the router's parameter length
**When** the stream is requested
**Then** it answers the same 404 body as `GET /status/:orgSlug` does for that miss, through `resolveOrganizationBySlug`, and opens no stream

**Given** a cross-origin `EventSource` reconnecting with `Last-Event-ID`
**When** the browser sends the preflight
**Then** `OPTIONS /status/:orgSlug/events` admits `last-event-id`, and the reconnected stream starts from the current page, ignoring the header

**Given** a client IP holding `PUBLIC_STREAM_MAX_PER_IP` open streams, or an api holding `PUBLIC_STREAM_MAX_TOTAL`
**When** one more is opened
**Then** it is refused with a 429 that is a `TooManyRequestsException`, carries the public headers, and opens nothing
**And** closing a stream frees its place at once

**Given** stream openings from one IP beyond the public rate limit
**When** the next is requested
**Then** it is refused with 429, as the page is

**Given** a stream open for `PUBLIC_STREAM_MAX_LIFETIME_SECONDS`
**When** that time passes
**Then** the server ends it

**Given** open streams
**When** the client disconnects, or the app is closed
**Then** the stream's hub subscription and its cap counts are released, and `app.close()` does not wait on the stream

**Given** the contract specs
**When** they run
**Then** `authenticated-surface.spec.ts` passes because the two operations are allowlisted by name, and `api-surface-parity.spec.ts` passes because this one slice is exempted by name; any other REST-only slice still fails it

### Story 4.6: Push the public page when it changes

As an integrator with an open stream,
I want the page pushed to me whenever what it shows changes,
So that my status page is live, and never shows what the organization did not publish.

**Actor:** human — an integrator
**Satisfies:** FR14 verification — "E2E tests assert SSE delivery after domain events"; DOMAIN, Public status page (the whole rule, and privacy-safe invalidation) and Canonical event catalog (Visibility); ARCHITECTURE section 5.4 (the decision of 2026-10-18)
**Files:** `src/modules/status-page/queries/open-public-status-stream/` (the push: coalesced recomposition per organization, per-stream last `ETag`), `tests/status-page/public-status-stream.feature` and `.steps.ts`
**Verification layer:** integration (`src/modules/status-page/public-status-stream.integration.test.ts`) and E2E (the Cucumber feature)

**Acceptance Criteria:**

**Given** an open stream
**When** a public incident is declared, an update posted to it, it is resolved, a window is scheduled or starts, or a visible service's status changes
**Then** the stream receives the new page, equal to what `GET /status/:orgSlug` then returns, with its `ETag` as the SSE `id`
**And** the Cucumber feature proves at least one incident, one maintenance and one service-status case over a real socket

**Given** an open stream
**When** a draft is created, edited, has an update posted, or is dismissed; a manual override is set on a private service; or an incident naming only private services changes
**Then** the stream receives nothing, because the page did not change

**Given** a listed incident or window, or a visible service
**When** the only service it names is made private or archived, or the window is deleted
**Then** the stream receives a page without it, and without its affected-service id (DOMAIN, privacy-safe invalidation)

**Given** a draft
**When** it is confirmed
**Then** the pushed page lists it, with its timeline opening at the confirmation entry

**Given** an admin-only event such as `incident.draft_created` or `monitor.threshold_breached`
**When** it arrives
**Then** no page is composed for it, so it cannot reach a public client even as timing

**Given** a burst of whitelisted events for one organization
**When** they arrive together
**Then** at most one composition is in flight per organization, with one more after it if events arrived meanwhile, and each stream receives the final page once
**And** an organization with no open stream composes nothing

**Given** the hub's `resync` signal
**When** it arrives
**Then** every open stream of every organization is recomposed and sent its page if it changed

**Given** a composition that fails
**When** it fails
**Then** the failure is logged, the streams stay open on their last page, and the next event tries again

**Given** the gate
**When** the change that makes a private service's change send nothing is reverted
**Then** that test fails, and the spec records that it did (Constraint 11)

### Story 4.7: Subscribe to organization events over GraphQL

As an operator,
I want my dashboard to subscribe to my organization's events over GraphQL,
So that it shows incident, service and monitor changes as they happen, drafts included.

**Actor:** human — an operator
**Satisfies:** FR15 verification — "E2E tests assert subscription events for incident and service changes"; FR27 (GraphQL subscriptions cover admin workflows); ARCHITECTURE sections 5.4.1 (every GraphQL transport bounded) and 5.5 (the subscription decisions of 2026-10-18)
**Files:** `src/server/index.ts` (mercurius `subscription` option and its WebSocket transport, the `Origin` check, the anonymous limit on the upgrade), `src/server/realtime/organization-events.graphql-schema.ts` and `organization-events.resolver.ts`, `src/shared/api/contract/authenticated-surface.spec.ts` (reads `src/server/realtime/` too), `src/shared/testing/graphql.ts` (a subscription client helper), `tests/admin/organization-events.feature` and `.steps.ts`
**Verification layer:** integration (`src/server/realtime/organization-events.integration.test.ts`) and E2E (the Cucumber feature)

**Acceptance Criteria:**

**Given** an operator with a valid session, connecting from `BETTER_AUTH_URL` or a trusted origin
**When** they subscribe to `organizationEvents`
**Then** each bridged event of their active organization arrives as `{ eventName, aggregateType, aggregateId, occurredAt }`, admin-only events included
**And** after the hub's `resync` they receive one `resync` event, so the client knows to re-read
**And** the Cucumber feature proves an incident case (`incident.created`, and `incident.draft_created` from a monitor-born draft) and a service case (`service.status_changed`)

**Given** an operator subscribed in one organization
**When** another organization's events occur
**Then** none reaches them

**Given** an upgrade with no session cookie, a junk or expired one, or a member whose role fails the ladder
**When** it subscribes
**Then** it is refused with `UNAUTHENTICATED`
**And** an upgrade without a valid session counts against the anonymous `/graphql` limit, so repeated attempts reach 429, while a valid session with no membership or a role off the ladder is refused but not rationed

**Given** a valid session cookie on an upgrade whose `Origin` is missing or not trusted
**When** it subscribes
**Then** it is refused, because a browser sends the cookie on a cross-site WebSocket upgrade

**Given** a query or mutation sent over the WebSocket connection
**When** it runs
**Then** it is refused, so the only GraphQL transport for queries and mutations stays the one 5.4.1's bounds and the resolvers' session check already cover; the story records this in ARCHITECTURE 5.5

**Given** the subscription resolver
**When** `authenticated-surface.spec.ts` runs
**Then** it reads the resolver, finds `Subscription.organizationEvents` calling `resolveOrganizationContext`, and would fail on a subscription field that does not

**Given** an open subscription
**When** the app is closed
**Then** the connection is closed and `app.close()` does not wait on it

*Amended during implementation (owner, loopback 1):* only an upgrade without a valid session is rationed. The original third AC also rationed a member whose role fails the ladder. Three socket bounds were added, and ARCHITECTURE 5.5 records them:
- A socket with no accepted subscription within 10 s of its upgrade is closed with 4408.
- One socket holds at most 10 live subscriptions; beyond that a subscribe is refused with `TOO_MANY_SUBSCRIPTIONS`.
- A refusal closes the socket with 4401, and a lookup failure masked as an internal error closes it with 4500.

See spec 4.7's owner decisions and triage rows #1–#3.

### Story 4.8: Close a subscription when access is lost

As an organization owner,
I want a subscription to stop within a minute of its operator losing access,
So that someone removed from my organization, or signed out, stops seeing its events.

**Actor:** human — the owner who removes the member; the re-check itself is the system
**Satisfies:** ARCHITECTURE section 5.5 (re-checked every `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`, decided 2026-10-18); FR3 (one organization's data invisible to everyone outside it)
**Files:** `src/server/realtime/organization-events.resolver.ts` (the periodic re-check), `src/config/env.ts` (`ADMIN_SUBSCRIPTION_RECHECK_SECONDS`, default 60), `.env.example`
**Verification layer:** integration (`src/server/realtime/organization-events-access.integration.test.ts`, with the interval shortened in the test)

**Acceptance Criteria:**

**Given** an open subscription
**When** its operator signs out, their session expires, or they are removed from the organization through Better Auth
**Then** the subscription is closed within one re-check interval, and no event of the organization reaches it after the close

**Given** an operator who switches their active organization while subscribed
**When** the re-check runs
**Then** the subscription keeps the organization it opened for while they are still a member of it, and closes once they are not

**Given** the re-check
**When** the session lookup itself fails
**Then** the subscription is closed, failing closed, and the failure is logged

**Given** the fix
**When** the re-check is disabled
**Then** the removal test fails, and the spec records that it did (Constraint 11)

### Story 4.9: Prove worker events reach api clients under Compose

As the system,
I want a test that runs the real stack and watches a worker-originated change arrive at the api's clients,
So that the backplane is proven across two processes, not only inside one.

**Actor:** system — CI's new `compose` job
**Satisfies:** FR16 verification — "Compose-based integration test proves worker-originated events reach API clients"; ARCHITECTURE section 9 (the `compose` job, decided 2026-10-18)
**Files:** `tests/compose/backplane.compose.test.ts`, a controlled check target the stack provides only to this test (a Compose service under its own profile, or equivalent), `package.json` (`test:compose`, with its glob quoted), `.github/workflows/ci.yml` (the `compose` job), `docker-compose.backplane.yml`, `AGENTS.md` (how to run it locally on its own stack)
**Verification layer:** compose (a real `api` and `worker` from the built image)

**Acceptance Criteria:**

**Given** the stack started as its own `watchdog-backplane` project (`COMPOSE_FILE=docker-compose.yml:docker-compose.backplane.yml`, `COMPOSE_PROFILES=app,backplane`, `up --build --wait`) from a freshly built image
**When** the test signs up an organization, creates a public service with a monitor whose `failure_threshold` the controlled target will breach, and opens both a public stream and an admin subscription against the `api`
**Then** the stream receives a page in which that service's status has moved, which only the worker's recomputation could cause
**And** the subscription receives `monitor.threshold_breached` and `incident.draft_created` for that monitor
**And** neither event was emitted in the `api` process, which runs no monitor checks

**Given** the monitor's target
**When** the stack runs
**Then** `MONITOR_ALLOWED_CIDRS` admits only the controlled target's network, so the target guard is not loosened for anything else

**Given** CI
**When** a pull request is opened
**Then** the `compose` job runs this test against its own stack, separate from the `database` job, and fails the build if it fails

**Given** the test's waits
**When** a delivery does not arrive
**Then** it fails within a stated bound derived from the monitor's interval and threshold, and its message names what did not arrive

*Amended during implementation (owner, 2026-10-21):*
- The stack runs as a separate Compose project, with its own database volume, from a `docker-compose.backplane.yml` override. It publishes only the api, on `127.0.0.1:3100`, so it never collides with the dev stack.
- The original AC started it with `docker compose --profile app up`, and AGENTS.md was to say that the integration suites need the `app` profile down. As built, AGENTS.md says the stack's own project exempts it from that rule.

See spec 4.9's owner decisions.

## Epic 6: Subscriber notifications

People find out without watching the page. A visitor subscribes by email and confirms, and is then told about every public change: each public incident timeline entry, and each maintenance window being scheduled, starting or completing. Anyone can also follow the page as an Atom feed.

**FRs covered:** FR19, FR20, FR21

Written 2026-10-21 from the following sources:
- DOMAIN (Subscriber, NotificationDelivery, NotificationCursor, the event catalog);
- ARCHITECTURE sections 5.4.1, 5.6 and 7.1;
- ROADMAP's three verification lines;
- the owner's sixteen decisions of 2026-10-21 (`docs/bmad/planning-artifacts/epic-6-open-decisions.md`).

Those decisions were recorded in DOMAIN and ARCHITECTURE before these stories were written. The ones that shape the stories:

- **A subscription covers the whole public page** of one organization.
- **REST only.** Subscribe, confirm, unsubscribe and the feed have no GraphQL form. ARCHITECTURE 7.1 records the exemption, and no admin GraphQL read of subscribers exists in v1.
- **Delivery comes from durable history, not from events.** A per-organization cursor reads `incident_updates.sequence` and maintenance timestamps, and re-reads 5 minutes behind itself. A ledger row is owed per subscriber and change. A dispatch step leases rows, sends outside any transaction, and retries 60 s, doubling to 1 h, for at most 8 attempts.
- **Plain text everywhere.** Emails are plain text over SMTP (`nodemailer`, Mailpit in Compose). Confirm and unsubscribe links act on GET and answer in plain text, and unsubscribe also takes RFC 8058's one-click POST.
- **The unsubscribe link is signed, not stored.** It carries the subscriber id and an HMAC keyed by `NOTIFICATION_LINK_SECRET`, so the worker can build it for every email (decision D17, taken while these stories were reviewed).
- **The anonymous form is bounded.** It allows 5 subscriptions per hour per client IP and one confirmation email per address every 10 minutes, and gives the same 202 whatever the address's state.
- **Atom only**, with the latest 50 entries.
- **One rule for what is public**, moved into `src/shared`, so the page, the feed and the emails cannot drift apart.

Ten stories, in order. Each depends only on earlier ones:

- 6.1 stops subscriber addresses reaching the logs before any is stored, as `deferred-work.md` requires.
- 6.2 sends email; 6.3–6.4 subscribe, confirm and unsubscribe.
- 6.5 shares the public rule; 6.6–6.7 owe and send the notifications.
- 6.8 serves the feed; 6.9 prunes; 6.10 proves the whole flow end to end.

The story order refines decision D16 in two places:
- The SMTP sender comes before subscribe, because subscribing sends the confirmation email.
- Sharing the public rule is a story of its own, because it touches the `status-page` module and the notification stories touch only `notification` (Constraint 1).

> **Constraint 5, surfaced.** Stories 6.1, 6.5 and 6.9 map to no ROADMAP verification line. 6.1 is the prerequisite `deferred-work.md` records against Epic 6. 6.5 is ARCHITECTURE 5.6's "one rule for what is public". 6.9 is DOMAIN's Retention rule. Each traces to a rule the owner decided, rather than to a line.
>
> **Cross-module reads.** The `notification` module reads `organization` (by slug), `incident_updates`, `incidents`, `incident_service_impacts`, `maintenance`, `maintenance_services` and `services`. Each story adds the tables it reads to `foreign-table-allowlist.spec.ts` before it reads them.
>
> **The worker.** The notification pass is a third worker loop beside maintenance and monitors (ARCHITECTURE 6.0). A test runs it scoped to its own organizations (`{ orgIds }`), never unscoped (AGENTS.md).
>
> **Mailpit in tests.** A test reads Mailpit's HTTP API through a helper in `src/shared/testing/`. It filters by a recipient address unique to the test, because integration files run concurrently and share one Mailpit.

### Story 6.1: Subscriber addresses never reach the logs

As the system,
I want every value a Postgres error or a wrapped error carries scrubbed from the logs,
So that a subscriber's address, once stored, cannot leak through an error message.

**Actor:** system — the loggers of the api and the worker
**Satisfies:** ARCHITECTURE 5.6 ("Subscriber addresses never reach logs"; "Logs are scrubbed first"); `deferred-work.md`, the two "Epic 6 prerequisite" entries from story 9.13 (Postgres error fields; nested, aggregate and `cause` errors)
**Files:** `src/shared/db/sql-debug.ts` (`LOG_REDACT_PATHS`, `appLoggerOptions`: the `err` and `error` serializers), `src/server/error-logging.ts`, `src/shared/exceptions/exception-base.ts` (`toJSON`'s `cause`), the worker's logger options in `src/worker.ts`
**Verification layer:** unit (the serializers and redaction), integration (a real unique-key violation logged through the error handler)

**Acceptance Criteria:**

**Given** a Postgres error whose `message`, `detail`, `where`, `hint` or `internal_query` holds a value, such as a unique violation's `Key (email)=(...)`
**When** it is logged as `err` or `error` by the api or the worker
**Then** each of those fields is redacted, and the error's code, constraint name and stack still print

**Given** a database error nested inside another error, inside an `AggregateError`, or carried as a `cause`, including `ExceptionBase`'s serialized `cause`
**When** it is logged
**Then** the nested error's values are redacted exactly as a top-level one's are

**Given** the event bus's default failure reporter and the seed script, which `deferred-work.md` lists as writing through `console.error`
**When** they report an error
**Then** they log through the scrubbed pino logger instead

**Given** the scrub
**When** each redaction is reverted
**Then** its test fails, and the spec records that it did (Constraint 11)

**And** both `deferred-work.md` entries are marked resolved by this story

### Story 6.2: Send email through SMTP

As the system,
I want one email sender that talks SMTP and is configured from `src/config`,
So that the subscribe flow and the notification pass both send mail the same way, to Mailpit locally.

**Actor:** system — the api (confirmation email) and the worker (notifications)
**Satisfies:** FR19 verification — "Integration tests verify messages are delivered to Mailpit"; ARCHITECTURE 5.6 (email transport)
**Files:** `src/modules/notification/domain/email-sender.port.ts`, `src/modules/notification/infrastructure/smtp-email-sender.ts` (`nodemailer`), `src/config/env.ts` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, optional `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, and `PUBLIC_BASE_URL`), `.env.example`, `docker-compose.yml` (`SMTP_FROM` and `PUBLIC_BASE_URL` for `api` and `worker`), `package.json`, `src/shared/testing/mailpit.ts` (read Mailpit's HTTP API by recipient)
**Verification layer:** unit (the SMTP result is classified as accepted, transient or permanent), integration (a message delivered to Mailpit)

**Acceptance Criteria:**

**Given** the sender configured for Compose's `mailpit`
**When** it sends a plain-text message
**Then** Mailpit holds exactly that message for that recipient, with `From` equal to `SMTP_FROM`, and with no HTML part

**Given** the SMTP server's answer
**When** the sender reports it
**Then** it says accepted, transient (a network error or a 4xx) or permanent (a 5xx), and its diagnostic never contains the recipient's address

**Given** the new settings
**When** `.env` omits them
**Then** the api and the worker still boot: the SMTP settings default to `localhost` on 1025, where Compose publishes Mailpit (inside Compose, `SMTP_HOST` is `mailpit`), and `PUBLIC_BASE_URL` defaults to `BETTER_AUTH_URL`'s origin
**And** `pnpm run test` passes with `.env` moved aside

### Story 6.3: Subscribe to an organization's status page

As a visitor to a public status page,
I want to subscribe with my email address,
So that I am told about the organization's incidents and maintenance without watching the page.

**Actor:** human — an anonymous visitor
**Satisfies:** FR21 verification — "E2E tests cover subscribe, …"; DOMAIN Subscriber (scope, tokens, subscribing again, throttle); ARCHITECTURE 5.4.1 (the four bounds), 5.6 (the subscribe route), 7.1 (REST-only)
**Files:**
- `db/migrations/*_create_subscribers.sql`;
- `src/modules/notification/commands/create-subscriber/` (`.handler.ts`, `.schema.ts`, `.public.route.ts`);
- `src/modules/notification/database/subscriber.repository.ts` and `organization-by-slug.repository.ts`, which read `organization` with `src/shared/domain/slug.ts`'s rule and `public-page-miss.ts`'s uniform miss;
- `src/shared/events/subscriber.events.ts`;
- `src/config/env.ts` (`SUBSCRIBE_RATE_LIMIT_MAX`, `SUBSCRIBE_RATE_LIMIT_WINDOW_MS`, `SUBSCRIBER_CONFIRMATION_TTL_HOURS`, `SUBSCRIBER_CONFIRMATION_RESEND_SECONDS`);
- `api-surface-parity.spec.ts` (`REST_ONLY_BY_DESIGN`), `authenticated-surface.spec.ts` (`PUBLIC_BY_DESIGN`), `foreign-table-allowlist.spec.ts` (`organization`).

**Verification layer:** integration (`src/modules/notification/` suites, reading Mailpit)

**Acceptance Criteria:**

**Given** the migration
**When** it runs
**Then** `subscribers` matches DOMAIN, Subscriber, including `subscribers_org_email_uk` on `(org_id, lower(email))`, with RLS enabled and `FORCE`d and the standard policy on `org_id`, and `tenant-rls-coverage.integration.test.ts` passes

**Given** `POST /status/:orgSlug/subscribers` with `{ email }` for a new address
**When** it is accepted
**Then** it answers 202, and a `pending` subscriber is stored with the address trimmed and lowercased
**And** its confirmation token is 32 random bytes, of which only the SHA-256 hash is stored, with `confirmation_expires_at` set `SUBSCRIBER_CONFIRMATION_TTL_HOURS` (default 24) ahead and `confirmation_sent_at` set
**And** a plain-text confirmation email reaches Mailpit, carrying a link under `PUBLIC_BASE_URL` with the confirmation token
**And** `subscriber.created` is emitted after the commit

**Given** the same request for an address that is `pending`, `confirmed` or `unsubscribed`
**When** it is accepted
**Then** the answer is byte-for-byte the same 202 as for a new address
**And** a `pending` address gets a new token and email
**And** a `confirmed` address is sent nothing
**And** an `unsubscribed` address returns to `pending` with a new token and email
**And** in every state, no confirmation email is sent if one was sent to that address for that organization within `SUBSCRIBER_CONFIRMATION_RESEND_SECONDS` (default 600), so repeating subscribe and unsubscribe cannot mail an address repeatedly

**Given** two first-time requests for the same address at once
**When** both run
**Then** both answer the same 202, exactly one subscriber row and one confirmation email result, and no unique-key violation reaches the client or the logs
**And** the throttle's read and write are serialized by a row lock, which a concurrency test proves (AGENTS.md, "One transaction does not serialize a read-check-write")

**Given** an unknown or malformed slug, or an invalid or over-long address
**When** it is posted
**Then** the unknown slug gets the public page's uniform miss, and the bad address a 400 that does not echo the address

**Given** one client IP
**When** it posts more than `SUBSCRIBE_RATE_LIMIT_MAX` times in a window
**Then** the next is refused with a 429 carrying the public headers and `Retry-After`
**And** the route answers its CORS preflight admitting `Content-Type`, without credentials

**Given** the confirmation email fails to send
**When** the request completes
**Then** the answer is still 202, and the failure is logged without the address

**Given** the contract specs
**When** they run
**Then** the slice is in `REST_ONLY_BY_DESIGN` and the operation in `PUBLIC_BY_DESIGN`, each with its reason

### Story 6.4: Confirm and unsubscribe through the emailed links

As a subscriber,
I want the links in my emails to confirm my subscription and to end it,
So that I receive notifications only after I have confirmed, and stop with one click.

**Actor:** human — a subscriber, through a link in an email
**Satisfies:** FR21 verification — "E2E tests cover … confirmation, unsubscribe …"; DOMAIN Subscriber (tokens); ARCHITECTURE 5.6 (links act on GET, plain text, one-click POST)
**Files:** `src/modules/notification/commands/confirm-subscriber/` and `unsubscribe/` (a cohesive pair over `subscribers`: one repository, one route pattern, no migration), each with `.handler.ts`, `.schema.ts` and `.public.route.ts`. The routes are:
- `GET /status/:orgSlug/subscribers/confirm?token=…`
- `GET` and `POST /status/:orgSlug/subscribers/unsubscribe?subscriber=…&signature=…`

The slug names the organization, so each lookup runs inside that organization's tenant transaction. The story also adds `src/modules/notification/domain/unsubscribe-link.ts` (sign and verify, an HMAC-SHA256 over the org id and subscriber id) and `NOTIFICATION_LINK_SECRET` in `src/config/env.ts`, which must keep `pnpm run test` green with `.env` moved aside. Also `src/shared/events/subscriber.events.ts`, `api-surface-parity.spec.ts` (`REST_ONLY_BY_DESIGN`), and `authenticated-surface.spec.ts` (`PUBLIC_BY_DESIGN`, one entry per method and path)
**Verification layer:** integration

**Acceptance Criteria:**

**Given** a `pending` subscriber's unexpired confirmation token
**When** its link is opened with GET
**Then** the subscriber is `confirmed` with `confirmed_at` set, the confirmation token hash is cleared, the answer is plain text, and `subscriber.confirmed` is emitted after the commit

**Given** a subscriber's signed unsubscribe link
**When** it is opened with GET, or posted to with `List-Unsubscribe=One-Click`
**Then** the subscriber is `unsubscribed`, the answer is plain text, and `subscriber.unsubscribed` is emitted
**And** using the link again gives the same plain-text answer and emits nothing, since the link never expires

**Given** a confirmation token that is unknown, expired (past `confirmation_expires_at`) or already used; an unsubscribe link with a wrong signature, or for a subscriber that no longer exists; or a link for another organization's subscriber used under this organization's slug
**When** the link is used
**Then** the answer is one uniform plain-text answer that does not say which, and nothing changes

**Given** either route
**When** the contract specs run
**Then** both are REST-only and public by design
**And** no log line carries a token or signature, including the request line Fastify logs with the URL, whose query string is redacted

**Given** the signature check
**When** it is replaced with one that accepts any signature
**Then** the wrong-signature test fails, and the spec records that it did (Constraint 11)

### Story 6.5: One rule for what is public

As the system,
I want the Public status page rule to live in one shared place,
So that the page, the feed and the notification emails decide what is public the same way.

**Actor:** system — every reader of public content
**Satisfies:** ARCHITECTURE 5.6 ("One rule for what is public"); DOMAIN Public status page
**Files:** `src/modules/status-page/domain/public-page.ts` moves to `src/shared/domain/public-page.ts`, with its spec; the status-page handlers and presenters import it from there
**Verification layer:** unit (the moved spec), integration (every public-page suite, unchanged)

**Acceptance Criteria:**

**Given** the move
**When** the suites run
**Then** every public-page, public-stream and e2e test passes unchanged, and `publishable` and `overallStatus` have no copy left in `src/modules`

**Given** a later reader in another module
**When** it imports the rule
**Then** it imports `src/shared/domain/public-page.ts`, and `dependency-cruiser` passes

### Story 6.6: Work out who is owed each public change

As the worker,
I want to read each organization's public changes since its cursor, and record one owed email per confirmed subscriber and change,
So that every confirmed subscriber is owed each public change exactly once, whatever the pass repeats.

**Actor:** system — the worker's notification pass
**Satisfies:** FR19 — "notification emails are generated for subscribed users"; DOMAIN NotificationDelivery (what notifies, who is told) and NotificationCursor; ARCHITECTURE 5.6 (cursor with overlap), 6.0 (per-organization loop)
**Files:**
- `db/migrations/*_create_notification_deliveries.sql` (both `notification_deliveries` and `notification_cursors`);
- `src/modules/notification/commands/queue-email-notifications/`;
- `src/modules/notification/database/` (ledger, cursor and history repositories);
- `src/modules/notification/commands/unsubscribe/` (stops pending deliveries);
- `src/worker.ts` (the notification loop, `NOTIFICATION_PASS_INTERVAL_MS`);
- `src/config/env.ts` (`NOTIFICATION_PASS_INTERVAL_MS`, default 30,000; `NOTIFICATION_CURSOR_OVERLAP_SECONDS`, default 300);
- `foreign-table-allowlist.spec.ts`;
- `src/shared/events/notification.events.ts`.

**Verification layer:** integration (scoped passes)

**Acceptance Criteria:**

**Given** the migration
**When** it runs
**Then** both tables match DOMAIN, including `notification_deliveries_once_uk` and the tenant-aware subscriber FK, each with RLS enabled and `FORCE`d and the standard policy

**Given** confirmed subscribers and a public incident timeline entry, or a maintenance window created, started or completed
**When** the pass runs for the organization
**Then** each subscriber confirmed before the change was recorded, and still confirmed, is owed one `pending` delivery per change
**And** `notification.email_queued` is emitted once per delivery

**Given** a draft-era entry, an incident or window naming only services the page omits, a window edited or deleted, or a subscriber pending, unsubscribed or confirmed after the change
**When** the pass runs
**Then** nothing is owed for it

**Given** an entry committed out of `sequence` order inside the overlap, and a pass run twice over the same history
**When** the passes run
**Then** the late entry is owed, and the repeat inserts nothing new

**Given** a subscriber who unsubscribes
**When** the unsubscribe commits
**Then** each of their `pending` deliveries is removed, so none is sent

**Given** an unsubscribe committing while the pass is owing a change to that subscriber
**When** both run
**Then** no `pending` delivery is left for them: the pass holds the subscriber row `for share` from its `confirmed` check to its insert, and the unsubscribe takes the row for update, which a concurrency test proves

**Given** the overlap
**When** the cursor's overlap read is removed
**Then** the out-of-order test fails, and the spec records that it did (Constraint 11)

### Story 6.7: Send owed emails, with retries

As the worker,
I want to send each owed email and record what the SMTP server answered,
So that a subscriber receives each notification at least once, and a failing server is retried and then given up on.

**Actor:** system — the worker's notification pass
**Satisfies:** FR19 verification — "Integration tests verify messages are delivered to Mailpit"; ARCHITECTURE 5.6 (no lock across a send, at-least-once, retries, `List-Unsubscribe`)
**Files:** `src/modules/notification/commands/send-queued-email/`, the ledger repository, `src/worker.ts` (dispatch after queueing in the notification loop; waits for sends in flight on shutdown), `src/config/env.ts` (`NOTIFICATION_RETRY_BASE_SECONDS`, `NOTIFICATION_RETRY_MAX_DELAY_SECONDS`, `NOTIFICATION_MAX_ATTEMPTS`), `foreign-table-allowlist.spec.ts`
**Verification layer:** unit (the backoff schedule), integration (Mailpit, and a stub sender for failures)

**Acceptance Criteria:**

**Given** a due `pending` delivery
**When** the pass dispatches it
**Then** it is claimed with `for update skip locked` in a short transaction that counts the attempt (`attempts + 1`) and leases the row by moving `next_attempt_at` forward by the delay that attempt would wait if it failed
**And** it is sent with no transaction open, and recorded `sent` with `sent_at` in a second transaction
**And** the sender's SMTP timeouts are shorter than `NOTIFICATION_RETRY_BASE_SECONDS`, so no lease expires during a send that is still running
**And** Mailpit holds a plain-text email naming the organization and the change, with a link to the public page
**And** the email has `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, carrying the subscriber's signed unsubscribe link built by story 6.4's `unsubscribe-link.ts`, and the same link in its body
**And** `notification.email_sent` is emitted

**Given** a transient failure
**When** it is retried
**Then** the waits are 60 s doubling to at most 3,600 s, and after `NOTIFICATION_MAX_ATTEMPTS` the delivery is `abandoned` and `notification.email_failed` is emitted

**Given** a permanent failure
**When** it is recorded
**Then** the delivery is `failed` at once, `notification.email_failed` is emitted, and `last_error` never contains the address

**Given** two passes at once, or a lease left by a crash
**When** they dispatch
**Then** no delivery is sent by both, and an expired lease is sent again

**Given** a `pending` delivery whose maintenance window has been deleted, or whose subscriber is no longer `confirmed`
**When** the pass reaches it
**Then** it is dropped, not sent

### Story 6.8: Follow a status page as an Atom feed

As someone following an organization's status,
I want an Atom feed of its incident and maintenance lifecycle,
So that my feed reader shows each public change in order.

**Actor:** human — an anonymous feed reader
**Satisfies:** FR20 verification — "Feed tests validate XML shape and event ordering for incident updates and maintenance created/started/completed events"; ARCHITECTURE 5.4.1 (bounds), 5.6 (the feed), 7.1 (REST-only)
**Files:** `src/modules/notification/queries/get-atom-feed/` (`.handler.ts`, `.public.route.ts`), a hand-built XML writer with escaping, `foreign-table-allowlist.spec.ts`, `api-surface-parity.spec.ts`, `authenticated-surface.spec.ts`
**Verification layer:** integration (XML shape and ordering)

**Acceptance Criteria:**

**Given** an organization with public incident timeline entries and maintenance windows created, started and completed
**When** `GET /status/:orgSlug/feed.atom` is requested
**Then** it answers `application/atom+xml` with a valid Atom document (`feed` with `id`, `title` and `updated`, and each `entry` with a stable `tag:` id, `title`, `updated` and `content`), holding the latest 50 changes, newest first, ties settled by id

**Given** a window that was created, started and completed
**When** the feed is built
**Then** it holds three entries for it, one for each, ordered by when each happened

**Given** more than 50 notifiable changes
**When** the feed is built
**Then** it holds only the newest 50

**Given** a draft-era entry, an incident or window naming only services the page omits, or any text with XML special characters
**When** the feed is built
**Then** the hidden items are absent and the text is escaped

**Given** the feed
**When** it is requested again with a matching `If-None-Match`, from another origin, or beyond the rate limit
**Then** it inherits the page's bounds: 304, CORS without credentials, and a 429 carrying the public headers
**And** an unknown slug gets the page's uniform miss

### Story 6.9: Prune old deliveries and subscribers

As the worker,
I want final deliveries, unsubscribed subscribers and never-confirmed subscribers removed on schedule,
So that the ledger and the anonymous form cannot grow without bound.

**Actor:** system — the worker's notification pass
**Satisfies:** DOMAIN NotificationDelivery Retention and Subscriber ("Never confirmed")
**Files:** `src/modules/notification/commands/prune-notifications/`, `src/worker.ts`, `src/config/env.ts` (`NOTIFICATION_RETENTION_DAYS`, `SUBSCRIBER_PENDING_GRACE_DAYS`)
**Verification layer:** integration (scoped passes)

**Acceptance Criteria:**

**Given** deliveries `sent`, `failed` or `abandoned` whose `created_at` is older than `NOTIFICATION_RETENTION_DAYS`
**When** the pass prunes
**Then** they are deleted, and `pending` deliveries and newer ones are not

**Given** a subscriber `unsubscribed` whose `updated_at`, set when they unsubscribed, is older than the same period
**When** the pass prunes
**Then** the subscriber and their remaining deliveries are deleted

**Given** a `pending` subscriber whose confirmation token expired more than `SUBSCRIBER_PENDING_GRACE_DAYS` ago
**When** the pass prunes
**Then** it is deleted, and a `confirmed` subscriber never is

### Story 6.10: Prove subscribe to unsubscribe end to end

As a visitor,
I want the whole flow, from subscribing to unsubscribing, to work as one,
So that the parts proven separately are proven together.

**Actor:** human — a visitor; the worker's pass runs scoped, as the system
**Satisfies:** FR21 verification — "E2E tests cover subscribe, confirmation, unsubscribe, and notification dispatch"; FR19 verification (delivery to Mailpit)
**Files:** `tests/notification/subscriber-flow.feature`, `.steps.ts`, `tests/support/` (Mailpit through `src/shared/testing/mailpit.ts`)
**Verification layer:** E2E (Cucumber)

**Acceptance Criteria:**

**Given** a visitor who subscribes to a public page
**When** they open the confirmation link from the email Mailpit received
**Then** they are confirmed

**Given** that subscriber
**When** an operator posts a public incident update and the notification pass runs for the organization
**Then** Mailpit receives one notification for them, with a working unsubscribe link

**Given** that subscriber
**When** they unsubscribe through the link and another update is posted and the pass runs
**Then** Mailpit receives nothing more for them

**Given** a subscriber who never confirms
**When** an update is posted and the pass runs
**Then** they are sent nothing
