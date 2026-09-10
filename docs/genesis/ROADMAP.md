# WatchDog Roadmap

This document owns the WatchDog v1 Definition of Done, phased delivery milestones, post-v1 roadmap, and explicit non-goals. Architecture, domain, AI, and README-level details are cross-linked rather than restated.

## 1. v1 Definition of Done

All Better Auth v1 organization roles, `owner`, `admin`, and `member`, can perform v1 write actions. Finer editor/viewer permissions are roadmap and are not part of v1.

| Area | Done when | Verification |
|---|---|---|
| Auth + organizations | Better Auth is mounted as a Fastify plugin; users can sign up, sign in, create organizations, switch active orgs, and belong to multiple orgs. | Integration tests cover signup, login, organization creation, active-org resolution, switching the active organization, and a user belonging to multiple organizations. |
| Teams + membership | Teams and memberships are provided by the Better Auth organization plugin; WatchDog consumes them for active-org context and authorization. | Unit and integration tests validate role lookup including different roles held by the same user in different organizations, membership-based org resolution, and access checks through Better Auth-owned tables. |
| Tenant isolation | All WatchDog tenant-scoped tables carry `org_id`; repository transactions set `app.current_org_id`; Postgres RLS prevents cross-org reads/writes. | RLS integration tests prove one org cannot read or mutate another org's rows. See `DOMAIN.md` for the canonical data/RLS contract. |
| Services + service groups | Authorized v1 users can create, update, group, archive/restore, and manually override service status. | REST and GraphQL tests cover service create/update, grouping, archive/restore commands, archived exclusion from public/active lists, and manual override behavior. |
| Effective service status | Service status resolves via the canonical precedence rule. | Pure-function unit tests cover manual override, active incident impact, active maintenance, and monitor-derived state. See `DOMAIN.md`. |
| Incidents | Authorized v1 users can create incidents, assign affected services, set impact, and transition through the incident lifecycle. | State-machine tests cover valid and invalid transitions. See `DOMAIN.md`. |
| Incident updates | Incident updates are append-only and visible on admin and public status surfaces. | Repository tests prove append-only behavior; API tests prove updates appear in timeline order. |
| Maintenance | Authorized v1 users can schedule maintenance windows and publish maintenance lifecycle events. | Tests cover scheduled, in-progress, and completed states. See `DOMAIN.md`. |
| Maintenance auto-transitions | Maintenance windows automatically transition based on time. | Worker/integration tests simulate time and verify transitions. |
| Monitoring configs | Authorized v1 users can configure HTTP(S), TCP, keyword-match, and SSL-expiry checks. | Validation tests cover all check types and invalid configs. |
| Monitoring worker | The `worker` entrypoint executes checks on configured intervals and persists results. | Worker integration tests run checks against controlled test endpoints. See `ARCHITECTURE.md` for runtime topology. |
| Check results storage | Check results are append-only and partitioned; daily uptime rollups are generated. | Migration tests verify partitioning; rollup tests validate daily aggregates; retention tests verify expired partitions are dropped according to `CHECK_RESULTS_RETENTION_DAYS`. See `DOMAIN.md`. |
| Draft auto-incidents | After N consecutive monitor failures, the system creates a draft incident requiring human confirmation. | Worker tests simulate failure thresholds and assert draft incident creation only. |
| Public SSE | Public status pages receive live incident, maintenance, and service-status updates over SSE. | E2E tests assert SSE delivery after domain events. See `ARCHITECTURE.md`. |
| Admin GraphQL subscriptions | Admin dashboards receive real-time updates through GraphQL subscriptions. | E2E tests assert subscription events for incident and service changes. |
| LISTEN/NOTIFY backplane | Cross-process fanout works between `api` and `worker` using Postgres `LISTEN/NOTIFY`. | Compose-based integration test proves worker-originated events reach API clients. See `ARCHITECTURE.md`. |
| Public status page | `/status/:orgSlug` renders the organization's services, active incidents, scheduled maintenance, and uptime history. | E2E tests cover public route rendering by org slug. |
| 90-day uptime | Public pages show 90-day uptime bars backed by daily rollups. | Rollup tests and public-page tests verify 90-day output shape. |
| Email notifications | Mailpit is included in compose; notification emails are generated for subscribed users. | Integration tests verify messages are delivered to Mailpit. |
| RSS/Atom feed | Public status pages expose a feed for incident and maintenance lifecycle events. | Feed tests validate XML shape and event ordering for incident updates and maintenance created/started/completed events. |
| Public subscribe flow | Visitors can subscribe to public status updates by email. | E2E tests cover subscribe, confirmation, unsubscribe, and notification dispatch. |
| AI Incident Copilot | AI can draft incident updates, suggest impact/affected services, and draft postmortems. All outputs require human approval. | Unit tests mock the provider port and assert draft-only outputs. See `AI.md`. |
| AI NL Query | Users can ask natural-language questions over status and uptime history. | Tests assert structured query intent, scoped data access, and response shape. See `AI.md`. |
| AI weekly digest | AI can draft a weekly operational digest for human review. | Tests assert digest generation from scoped events/rollups and no autonomous publishing. See `AI.md`. |
| AI provider port | AI use cases depend on a provider-agnostic port; Azure AI Foundry is only an adapter implementation. | Unit tests inject a fake provider; adapter tests cover Foundry request/response mapping. See `AI.md`. |
| REST API | REST endpoints exist under `/api` with TypeBox schemas and Swagger coverage. | Contract tests validate schemas; Swagger is available at `/api-docs`. |
| GraphQL API | GraphQL queries/mutations/subscriptions cover admin workflows. | GraphQL integration tests cover protocol parity with REST where applicable. |
| Full test suite | Unit, integration, Cucumber/Gherkin E2E, and k6 load tests exist for the v1 workflows. | `pnpm check`, unit, integration, E2E, and k6 scripts run successfully. |
| Docker Compose | One `docker-compose` runs migration, API, worker, Postgres, and Mailpit. | Fresh clone can start the full stack with documented commands. |
| CI | GitHub Actions runs check, unit tests, migrations, integration tests, E2E tests, k6 smoke, and Docker build validation against a Postgres service container. | CI passes on pull requests and main branch pushes. |
| No deploy target | CI intentionally stops at verification and does not deploy. | Workflow contains no deployment job. |

## 2. Phased Milestones

| Phase | Scope | Rationale |
|---|---|---|
| 1. Foundation: tenancy, auth, migrations, RLS | Better Auth plugin, committed Better Auth DBMate migration, active-org CQRS context, role lookup, RLS enforcement, base repository ports, owner/app database roles. | Tenant isolation and identity must exist before any domain data can be safely created. |
| 2. Core status domain | Services, service groups, archive/restore, manual status override, incidents, incident updates, maintenance, state machines, status-resolution rule. | Public and admin status behavior depends on the core domain model and lifecycle rules. |
| 3. API surfaces + public status page | REST, GraphQL, Swagger, public `/status/:orgSlug`, admin queries/mutations, 90-day uptime read model shape. | Once the domain is stable, expose protocol-agnostic handlers through both API surfaces. |
| 4. Real-time backplane | In-process domain events, Postgres `LISTEN/NOTIFY` bridge, public SSE, admin GraphQL subscriptions. | Real-time delivery depends on stable domain events and must work across `api` and `worker` processes. |
| 5. Monitoring worker + uptime rollups | Worker entrypoint, HTTP(S)/TCP/keyword/SSL checks, check-result partitions, partition retention, daily rollups, draft auto-incidents. | Monitoring depends on services and the event/backplane foundation; draft incidents depend on incident workflows. |
| 6. Notifications, AI, hardening | Mailpit email, RSS/Atom, subscribe flow, Incident Copilot, NL Query, weekly digest, full E2E/k6 coverage, compose polish, CI. | These features compose existing domain events, status history, and public/admin workflows; hardening closes v1. |

## 3. Roadmap: Post-v1

| Order | Item | Why later |
|---:|---|---|
| 1 | Editor/viewer RBAC | v1 uses Better Auth owner/admin/member roles; finer permissions add complexity after core workflows are proven. |
| 2 | Hard service deletion with cascade/retention rules | v1 archives services non-destructively; hard deletion needs careful monitor, incident, rollup, notification, and audit retention semantics. |
| 3 | Maintenance update timeline, append-only and mirroring incident updates | v1 models maintenance lifecycle events; a full timeline adds extra UX and notification semantics after the core lifecycle is stable. |
| 4 | Webhooks | Email and RSS are enough for a self-hosted demo; webhooks require delivery retries, signing, and failure management. |
| 5 | Slack/SMS notifications | These introduce third-party credentials, provider-specific delivery semantics, and extra local-demo complexity. |
| 6 | Public API | v1 focuses on first-party REST/GraphQL surfaces; a public API needs versioning, auth scopes, rate limits, and external docs. |
| 7 | Status badges | Badges are useful once public API/read-model semantics stabilize. |
| 8 | Subdomain routing | v1 uses path-based `/status/:orgSlug`; subdomains require local/dev DNS and deployment assumptions. |
| 9 | Custom-domain routing | Custom domains require DNS validation, TLS automation, and production hosting assumptions outside v1. |
| 10 | Multi-region checks | v1 keeps monitoring self-contained in one compose stack; multi-region checks require distributed workers and region-aware rollups. |
| 11 | Correlation/triage agent | v1 AI is assistive and human-approved; correlation needs more operational signal and confidence controls. See `AI.md`. |
| 12 | Remediation agent | Remediation is higher-risk than drafting and must wait until approval, audit, and rollback patterns are mature. See `AI.md`. |
| 13 | MCP server | External-agent integration is valuable after the internal provider port and AI use cases stabilize. See `AI.md`. |

## 4. Explicit Non-goals for v1

| Non-goal | v1 decision | Owned by |
|---|---|---|
| Managed auth SaaS | Auth is self-hosted with Better Auth as a Fastify plugin. | `ARCHITECTURE.md` |
| ORM | Data access uses raw SQL via `postgres.js`; migrations use DBMate. | `ARCHITECTURE.md`, `DOMAIN.md` |
| Second migration tool | DBMate is the single migration source of truth, including committed Better Auth schema migrations. | `ARCHITECTURE.md` |
| Serverless hosting | v1 runs as containerized `api` and `worker` entrypoints from one image. | `ARCHITECTURE.md` |
| Separate TSDB | Uptime uses partitioned Postgres tables and daily materialized rollups. | `DOMAIN.md` |
| Extra message broker | Cross-process fanout uses Postgres `LISTEN/NOTIFY`, not Redis, NATS, Kafka, or RabbitMQ. | `ARCHITECTURE.md` |
| Hard service deletion | v1 uses archive/restore and intentionally avoids hard service deletion. | `DOMAIN.md`, `ROADMAP.md` |
| Subdomain routing | Public status pages use path-based `/status/:orgSlug`. | `README.md`, `ARCHITECTURE.md` |
| Custom-domain routing | Custom domains are deferred until after v1. | `README.md` |
| SMS notifications | v1 notifications are Mailpit email plus RSS/Atom. | `README.md` |
| Slack notifications | Slack is deferred with other external notification providers. | `README.md` |
| Webhooks | Webhooks are post-v1. | `README.md` |
| Autonomous AI posting | AI can draft and suggest only; humans approve every customer-facing action. | `AI.md` |
| AI remediation | Remediation agent is roadmap, not v1. | `AI.md` |
| Public write API | v1 exposes first-party app APIs only; external public API is roadmap. | `README.md` |
| Managed deployment target | CI verifies the app but does not deploy it. | `README.md`, `ARCHITECTURE.md` |
| Cursor, Claude Code, or spec-kit documentation | AI dev tooling is not part of genesis product docs. | `AI.md` |
