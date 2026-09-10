---
title: WatchDog PRD
stepsCompleted: []
---

# WatchDog Product Requirements

## How to read this document

This is a **transcription**, not a fresh elaboration. Every requirement below is lifted from `docs/genesis/ROADMAP.md`'s v1 Definition of Done, which was settled through several review rounds before implementation began.

Those genesis documents remain authoritative:

- `docs/genesis/DOMAIN.md` owns entities, the ERD, RLS policies, state machines, status-resolution precedence, monitoring persistence and the canonical event catalog.
- `docs/genesis/ARCHITECTURE.md` owns runtime wiring, the api/worker split, LISTEN/NOTIFY fanout, RLS enforcement mechanics, Compose and CI.
- `docs/genesis/AI.md` owns the agentic-AI product spec.
- `docs/genesis/README.md` owns the pitch, stack and scope.

This file exists because `bmad-create-epics-and-stories` requires a PRD with extractable requirements. It deliberately points at the genesis documents rather than restating them: a second copy of a decision is the drift these documents were written to avoid.

**When decomposing these into epics and stories, do not re-derive settled decisions.** If a requirement seems to need a technical choice, the choice has almost certainly already been made in DOMAIN or ARCHITECTURE. Look there first.

## Product scope

WatchDog is a self-hosted, multi-tenant status page platform for teams that want Statuspage-style visibility without handing core operations to a managed SaaS. Organizations manage services, incidents, scheduled maintenance, endpoint monitoring, public status pages, notifications and human-gated AI assistance from one backend-first application that runs locally through Docker Compose.

Shared database, `org_id` row-scoping, Postgres RLS with `FORCE`. Path-based public routing at `/status/:orgSlug`. Better Auth owns identity, organizations, teams and membership. All AI output is human-in-the-loop.

## Functional requirements

### FR1: Auth + organizations

- **Requirement:** Better Auth is mounted as a Fastify plugin; users can sign up, sign in, create organizations, switch active orgs, and belong to multiple orgs.
- **Verification:** Integration tests cover signup, login, organization creation, active-org resolution, switching the active organization, and a user belonging to multiple organizations.
- **Phase:** 1
- **Current status:** Partial - Better Auth is mounted at `/api/auth/*`, and signup, signin, organization creation and active-org resolution are covered by integration tests through the same Fastify instance the api entrypoint builds, verified end to end against the Compose stack. Two clauses of this requirement are not yet covered: switching the active organization, and a user belonging to more than one organization. Both exercise the code path every later epic depends on - switching is the only route that writes `session.activeOrganizationId`, and multi-org membership is what makes the `firstMembershipOf` fallback non-trivial.

### FR2: Teams + membership

- **Requirement:** Teams and memberships are provided by the Better Auth organization plugin; WatchDog consumes them for active-org context and authorization.
- **Verification:** Unit and integration tests validate role lookup including different roles held by the same user in different organizations, membership-based org resolution, and access checks through Better Auth-owned tables.
- **Phase:** 1
- **Current status:** Done - `src/server/auth/organization-context.ts` resolves session to active organization to role, falling back to membership when the session carries no active org, and rejects a role outside the owner/admin/member ladder. Covered by integration tests.

### FR3: Tenant isolation

- **Requirement:** All WatchDog tenant-scoped tables carry `org_id`; repository transactions set `app.current_org_id`; Postgres RLS prevents cross-org reads/writes.
- **Verification:** RLS integration tests prove one org cannot read or mutate another org's rows. See `DOMAIN.md` for the canonical data/RLS contract.
- **Phase:** 1
- **Current status:** Done - service_groups carries RLS enabled and FORCEd; 12 integration tests prove isolation, and a structural test covers every future org_id table.

### FR4: Services + service groups

- **Requirement:** Authorized v1 users can create, update, group, archive/restore, and manually override service status.
- **Verification:** REST and GraphQL tests cover service create/update, grouping, archive/restore commands, archived exclusion from public/active lists, and manual override behavior.
- **Phase:** 2

### FR5: Effective service status

- **Requirement:** Service status resolves via the canonical precedence rule.
- **Verification:** Pure-function unit tests cover manual override, active incident impact, active maintenance, and monitor-derived state. See `DOMAIN.md`.
- **Phase:** 2

### FR6: Incidents

- **Requirement:** Authorized v1 users can create incidents, assign affected services, set impact, and transition through the incident lifecycle.
- **Verification:** State-machine tests cover valid and invalid transitions. See `DOMAIN.md`.
- **Phase:** 2

### FR7: Incident updates

- **Requirement:** Incident updates are append-only and visible on admin and public status surfaces.
- **Verification:** Repository tests prove append-only behavior; API tests prove updates appear in timeline order.
- **Phase:** 2

### FR8: Maintenance

- **Requirement:** Authorized v1 users can schedule maintenance windows and publish maintenance lifecycle events.
- **Verification:** Tests cover scheduled, in-progress, and completed states. See `DOMAIN.md`.
- **Phase:** 2

### FR9: Maintenance auto-transitions

- **Requirement:** Maintenance windows automatically transition based on time.
- **Verification:** Worker/integration tests simulate time and verify transitions.
- **Phase:** 2

### FR10: Monitoring configs

- **Requirement:** Authorized v1 users can configure HTTP(S), TCP, keyword-match, and SSL-expiry checks.
- **Verification:** Validation tests cover all check types and invalid configs.
- **Phase:** 5

### FR11: Monitoring worker

- **Requirement:** The `worker` entrypoint executes checks on configured intervals and persists results.
- **Verification:** Worker integration tests run checks against controlled test endpoints. See `ARCHITECTURE.md` for runtime topology.
- **Phase:** 5

### FR12: Check results storage

- **Requirement:** Check results are append-only and partitioned; daily uptime rollups are generated.
- **Verification:** Migration tests verify partitioning; rollup tests validate daily aggregates; retention tests verify expired partitions are dropped according to `CHECK_RESULTS_RETENTION_DAYS`. See `DOMAIN.md`.
- **Phase:** 5

### FR13: Draft auto-incidents

- **Requirement:** After N consecutive monitor failures, the system creates a draft incident requiring human confirmation.
- **Verification:** Worker tests simulate failure thresholds and assert draft incident creation only.
- **Phase:** 5

### FR14: Public SSE

- **Requirement:** Public status pages receive live incident, maintenance, and service-status updates over SSE.
- **Verification:** E2E tests assert SSE delivery after domain events. See `ARCHITECTURE.md`.
- **Phase:** 4

### FR15: Admin GraphQL subscriptions

- **Requirement:** Admin dashboards receive real-time updates through GraphQL subscriptions.
- **Verification:** E2E tests assert subscription events for incident and service changes.
- **Phase:** 4

### FR16: LISTEN/NOTIFY backplane

- **Requirement:** Cross-process fanout works between `api` and `worker` using Postgres `LISTEN/NOTIFY`.
- **Verification:** Compose-based integration test proves worker-originated events reach API clients. See `ARCHITECTURE.md`.
- **Phase:** 4

### FR17: Public status page

- **Requirement:** `/status/:orgSlug` renders the organization's services, active incidents, scheduled maintenance, and uptime history.
- **Verification:** E2E tests cover public route rendering by org slug.
- **Phase:** 3

### FR18: 90-day uptime

- **Requirement:** Public pages show 90-day uptime bars backed by daily rollups.
- **Verification:** Rollup tests and public-page tests verify 90-day output shape.
- **Phase:** 3

### FR19: Email notifications

- **Requirement:** Mailpit is included in compose; notification emails are generated for subscribed users.
- **Verification:** Integration tests verify messages are delivered to Mailpit.
- **Phase:** 6

### FR20: RSS/Atom feed

- **Requirement:** Public status pages expose a feed for incident and maintenance lifecycle events.
- **Verification:** Feed tests validate XML shape and event ordering for incident updates and maintenance created/started/completed events.
- **Phase:** 6

### FR21: Public subscribe flow

- **Requirement:** Visitors can subscribe to public status updates by email.
- **Verification:** E2E tests cover subscribe, confirmation, unsubscribe, and notification dispatch.
- **Phase:** 6

### FR22: AI Incident Copilot

- **Requirement:** AI can draft incident updates, suggest impact/affected services, and draft postmortems. All outputs require human approval.
- **Verification:** Unit tests mock the provider port and assert draft-only outputs. See `AI.md`.
- **Phase:** 6

### FR23: AI NL Query

- **Requirement:** Users can ask natural-language questions over status and uptime history.
- **Verification:** Tests assert structured query intent, scoped data access, and response shape. See `AI.md`.
- **Phase:** 6

### FR24: AI weekly digest

- **Requirement:** AI can draft a weekly operational digest for human review.
- **Verification:** Tests assert digest generation from scoped events/rollups and no autonomous publishing. See `AI.md`.
- **Phase:** 6

### FR25: AI provider port

- **Requirement:** AI use cases depend on a provider-agnostic port; Azure AI Foundry is only an adapter implementation.
- **Verification:** Unit tests inject a fake provider; adapter tests cover Foundry request/response mapping. See `AI.md`.
- **Phase:** 6

### FR26: REST API

- **Requirement:** REST endpoints exist under `/api` with TypeBox schemas and Swagger coverage.
- **Verification:** Contract tests validate schemas; Swagger is available at `/api-docs`.
- **Phase:** 3

### FR27: GraphQL API

- **Requirement:** GraphQL queries/mutations/subscriptions cover admin workflows.
- **Verification:** GraphQL integration tests cover protocol parity with REST where applicable.
- **Phase:** 3

## Non-functional requirements

### NFR28: Full test suite

- **Requirement:** Unit, integration, Cucumber/Gherkin E2E, and k6 load tests exist for the v1 workflows.
- **Verification:** `pnpm check`, unit, integration, E2E, and k6 scripts run successfully.
- **Phase:** 6

### NFR29: Docker Compose

- **Requirement:** One `docker-compose` runs migration, API, worker, Postgres, and Mailpit.
- **Verification:** Fresh clone can start the full stack with documented commands.
- **Phase:** 6
- **Current status:** Done - postgres, mailpit, migrate, api and worker all report healthy from one image.

### NFR30: CI

- **Requirement:** GitHub Actions runs check, unit tests, migrations, integration tests, E2E tests, k6 smoke, and Docker build validation against a Postgres service container.
- **Verification:** CI passes on pull requests and main branch pushes.
- **Phase:** 6
- **Current status:** Partial - check, database and docker jobs run. Cucumber E2E and k6 smoke are not wired yet.

### NFR31: No deploy target

- **Requirement:** CI intentionally stops at verification and does not deploy.
- **Verification:** Workflow contains no deployment job.
- **Phase:** 6
- **Current status:** Done - no deployment job exists.

## Epic seeds

Epics follow ROADMAP's six phases verbatim. The ordering is load-bearing: tenant isolation precedes any tenant data, the domain precedes the API surfaces that expose it, real-time precedes the worker that feeds it, and monitoring precedes the draft incidents it generates.

| Phase | Scope | Rationale |
|---|---|---|
| 1. Foundation: tenancy, auth, migrations, RLS | Better Auth plugin, committed Better Auth DBMate migration, active-org CQRS context, role lookup, RLS enforcement, base repository ports, owner/app database roles. | Tenant isolation and identity must exist before any domain data can be safely created. |
| 2. Core status domain | Services, service groups, archive/restore, manual status override, incidents, incident updates, maintenance, state machines, status-resolution rule. | Public and admin status behavior depends on the core domain model and lifecycle rules. |
| 3. API surfaces + public status page | REST, GraphQL, Swagger, public `/status/:orgSlug`, admin queries/mutations, 90-day uptime read model shape. | Once the domain is stable, expose protocol-agnostic handlers through both API surfaces. |
| 4. Real-time backplane | In-process domain events, Postgres `LISTEN/NOTIFY` bridge, public SSE, admin GraphQL subscriptions. | Real-time delivery depends on stable domain events and must work across `api` and `worker` processes. |
| 5. Monitoring worker + uptime rollups | Worker entrypoint, HTTP(S)/TCP/keyword/SSL checks, check-result partitions, partition retention, daily rollups, draft auto-incidents. | Monitoring depends on services and the event/backplane foundation; draft incidents depend on incident workflows. |
| 6. Notifications, AI, hardening | Mailpit email, RSS/Atom, subscribe flow, Incident Copilot, NL Query, weekly digest, full E2E/k6 coverage, compose polish, CI. | These features compose existing domain events, status history, and public/admin workflows; hardening closes v1. |


## Out of scope for v1

Transcribed from ROADMAP section 4. These are decisions, not omissions; do not create stories for them.

Editor/viewer RBAC (v1 uses Better Auth's owner/admin/member, all of which can perform v1 writes) · hard service deletion (archive only) · webhooks · Slack and SMS notifications · public write API · status badges · subdomain routing · custom-domain routing · multi-region checks · correlation/triage agent · remediation agent · MCP server · managed auth SaaS · an ORM · a second migration runner · serverless hosting · a separate time-series database · any extra message broker · autonomous AI posting · any deployment target.
