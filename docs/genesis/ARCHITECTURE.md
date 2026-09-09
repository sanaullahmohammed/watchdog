# ARCHITECTURE.md

WatchDog is a backend-first, self-hosted, multi-tenant status page platform built on the selected Fastify boilerplate constraints: TypeScript on Node 24+, Fastify 5, Awilix DI, Pino logging, CQRS, raw SQL through `postgres.js`, DBMate migrations, REST, GraphQL, SSE, and a single Docker Compose topology.

This document owns runtime architecture, CQRS/DDD/vertical-slice mapping, the two-entrypoint model, the in-process bus vs Postgres `LISTEN/NOTIFY` backplane, real-time fanout, auth-as-plugin integration, RLS enforcement mechanics, Compose topology, and CI shape. Domain entities, state machines, status-resolution rules, monitoring persistence, retention, and canonical event names are owned by [DOMAIN.md](./DOMAIN.md).

---

## 1. Architectural stance

WatchDog uses Clean Architecture, DDD, CQRS, and vertical slices because the product is naturally split into cohesive business capabilities that must remain extractable: service catalog, incidents, maintenance, monitoring, notifications, public status-page reads, and AI-assisted workflows.

The core rule is framework-agnostic business logic. Domain models, use-case handlers, repository ports, and domain events live below Fastify, Mercurius, SSE, PostgreSQL, and Better Auth. HTTP routes and GraphQL resolvers are adapters that translate protocol input into commands or queries; they do not own business decisions.

CQRS is the boundary between protocol adapters and use cases:

- Commands mutate state and emit domain events.
- Queries compose read models and return protocol-neutral DTOs.
- Middleware injects authenticated user, active organization, role, request metadata, and RLS context before a handler runs.
- Cross-module request-response interactions go through command/query buses.
- Cross-module fire-and-forget reactions go through the event bus.

Vertical slices live under `src/modules/<feature>/` and keep commands, queries, domain logic, database adapters, and DTOs close to the feature. Direct imports between modules are forbidden; module boundaries are crossed through buses or emitted events. This preserves the option to extract modules later without untangling framework or persistence dependencies.

```text
src/modules/<feature>/
  commands/
  queries/
  domain/
  database/
  dtos/
```

The data layer is raw SQL through `postgres.js` inside repository adapters that implement repository ports. There is no ORM. DBMate is the single migration source of truth.

---

## 2. Module topology

Event names below reference the canonical event catalog in [DOMAIN.md](./DOMAIN.md) by name only.

| Module | Responsibility | Key commands / queries | Emitted events |
|---|---|---|---|
| `organization` | Active-organization resolution, org slug lookup, org switcher data, and membership/role context through Better Auth-owned organization plugin tables. Org/team/membership mutations happen inside Better Auth; WatchDog does not own their DDL or domain events. If default WatchDog rows are later needed after org creation, use a Better Auth after-hook that calls a command directly instead of emitting a WatchDog domain event. | `ResolveOrganizationBySlugQuery`, `ListMyOrganizationsQuery`, `ResolveActiveOrganizationContextQuery`, `SwitchActiveOrganizationCommand` | None |
| `service` | Services/components, service groups, public ordering, archive/restore lifecycle, manual status override, status recomputation orchestration. | `CreateServiceCommand`, `UpdateServiceCommand`, `ArchiveServiceCommand`, `RestoreServiceCommand`, `SetManualStatusOverrideCommand`, `ClearManualStatusOverrideCommand`, `CreateServiceGroupCommand`, `UpdateServiceGroupCommand`, `DeleteServiceGroupCommand`, `ListServicesQuery`, `GetServiceQuery` | `service.created`, `service.updated`, `service.archived`, `service.restored`, `service.status_changed`, `service.manual_override_set`, `service.manual_override_cleared`, `service_group.created`, `service_group.updated`, `service_group.deleted` |
| `incident` | Incident aggregate, append-only updates, affected-service impact, lifecycle transitions, draft confirmation/dismissal. | `CreateIncidentCommand`, `ConfirmDraftIncidentCommand`, `DismissDraftIncidentCommand`, `UpdateIncidentCommand`, `PostIncidentUpdateCommand`, `ResolveIncidentCommand`, `ListIncidentsQuery`, `GetIncidentTimelineQuery` | `incident.created`, `incident.draft_created`, `incident.confirmed`, `incident.updated`, `incident.update_posted`, `incident.state_changed`, `incident.resolved`, `incident.dismissed` |
| `maintenance` | Scheduled maintenance windows, affected services, idempotent worker-driven lifecycle transitions. | `CreateMaintenanceCommand`, `UpdateMaintenanceCommand`, `DeleteMaintenanceCommand`, `StartDueMaintenanceCommand`, `CompleteDueMaintenanceCommand`, `ListMaintenanceQuery`, `GetMaintenanceQuery` | `maintenance.created`, `maintenance.updated`, `maintenance.started`, `maintenance.completed`, `maintenance.deleted` |
| `monitoring` | Synthetic monitor configuration, worker check execution, check result persistence, consecutive-failure tracking, uptime rollup refresh, partition maintenance, draft incident generation. | `CreateMonitorCommand`, `UpdateMonitorCommand`, `DeleteMonitorCommand`, `RunDueMonitorChecksCommand`, `RecordCheckResultCommand`, `RefreshUptimeRollupsCommand`, `MaintainCheckResultPartitionsCommand`, `ListMonitorsQuery`, `GetMonitorResultsQuery` | `monitor.created`, `monitor.updated`, `monitor.deleted`, `monitor.check_succeeded`, `monitor.check_failed`, `monitor.recovered`, `monitor.threshold_breached`, `monitor.ssl_expiry_warning`, `uptime.rollup_refreshed` |
| `notification` | Public subscribers, confirmation/unsubscribe flow, email dispatch via Mailpit, RSS/Atom feed generation, event-driven notification dispatch. | `CreateSubscriberCommand`, `ConfirmSubscriberCommand`, `UnsubscribeCommand`, `QueueEmailNotificationCommand`, `SendQueuedEmailCommand`, `GetRssFeedQuery`, `GetAtomFeedQuery` | `subscriber.created`, `subscriber.confirmed`, `subscriber.unsubscribed`, `notification.email_queued`, `notification.email_sent`, `notification.email_failed` |
| `ai` | Provider port, incident copilot, postmortem draft, NL query over status history, weekly digest draft. All customer-facing actions stay human-in-the-loop. | `DraftIncidentUpdateCommand`, `DraftPostmortemCommand`, `DraftWeeklyDigestCommand`, `AnswerStatusHistoryQuestionQuery` | `ai.incident_update_drafted`, `ai.postmortem_drafted`, `ai.weekly_digest_drafted`, `ai.nl_query_answered` |
| `status-page` | Public per-org read side, status page payload composition, 90-day uptime payload, public SSE stream. | `GetPublicStatusPageQuery`, `GetPublicUptimeHistoryQuery`, `OpenPublicStatusEventStreamQuery` | None; consumes bridged events and read models. |
| `auth` | Not a domain module. Better Auth Fastify plugin plus session-to-context middleware outside the CQRS bus. | `GetSession`, `RequireSession`, `ResolveRequestActor`, `ResolveActiveOrgRole` | None owned by WatchDog architecture. |

---

## 3. Request lifecycle

All REST and GraphQL entrypoints converge on the same CQRS handlers.

```text
Route / Resolver
  -> request schema validation
  -> Better Auth session read
  -> pre-tenant org lookup when needed
  -> CQRS middleware
       - auth context
       - active org resolution
       - resolved org id shape validation
       - role resolution
       - command/query context injection
  -> Handler
  -> Domain model / domain service
  -> Repository port
  -> Repository adapter
       - postgres.js transaction
       - SET LOCAL app.current_org_id = '<resolved-org-id>'
       - raw SQL under RLS
  -> commit
  -> after-commit event publication
```

Protocol adapters are thin:

```text
REST route or GraphQL resolver
  parses input
  calls commandBus.execute(...) or queryBus.execute(...)
  maps result/error to protocol response
```

The tenant-context injection step is explicit and mandatory. CQRS middleware resolves `session -> user -> active organization -> role` through Better Auth-owned user, organization, membership, team, invitation, and role data. After active-org resolution and before any repository sets `app.current_org_id`, the middleware validates the resolved org id against the Better Auth id format, not a UUID regex. A malformed org id is rejected with a 4xx response so a resolution bug fails loudly instead of surfacing as an empty tenant.

The middleware then injects a command/query context similar to:

```ts
type RequestContext = {
  requestId: string;
  userId: string | null;
  orgId: string;
  orgRole: 'owner' | 'admin' | 'member';
  isPublicRead: boolean;
};
```

Public status-page reads resolve `/status/:orgSlug` through the pre-tenant path before a GUC exists. Authenticated admin requests resolve the active organization from the session and Better Auth organization plugin membership data. After `orgId` is resolved and validated, all WatchDog tenant-scoped repository operations set `app.current_org_id` inside the transaction.

Repository shape:

```ts
type TxContext = {
  sql: import('postgres').Sql;
  orgId: string;
};

function assertValidBetterAuthOrgId(orgId: string): void {
  // Use the Better Auth id contract pinned by the committed schema/migration.
  // Reject empty, malformed, or unexpected ids before RLS is reached.
}

async function withTenantTransaction<T>(
  sql: import('postgres').Sql,
  ctx: RequestContext,
  work: (tx: TxContext) => Promise<T>,
): Promise<T> {
  assertValidBetterAuthOrgId(ctx.orgId);

  return sql.begin(async tx => {
    await tx`select set_config('app.current_org_id', ${ctx.orgId}, true)`;
    return work({ sql: tx, orgId: ctx.orgId });
  });
}
```

Handlers should not accept arbitrary `orgId` from user input. The effective organization always comes from request context.

---

## 4. Two-entrypoint runtime

WatchDog builds one Docker image and runs two commands from it:

| Entrypoint | Runs | Primary responsibilities |
|---|---|---|
| `api` | Fastify HTTP server | REST API, GraphQL API, Swagger, Better Auth plugin, public status page reads, public SSE, admin GraphQL subscriptions, Postgres `LISTEN` subscriber for client fanout. |
| `worker` | Worker process | Synthetic monitor scheduler/executor, maintenance state transitions, uptime rollup refresh, check-result partition maintenance, old rollup pruning, email dispatch, background notification workflows, Postgres `LISTEN` subscriber for worker-side cross-process reactions when needed. |

The image is shared so dependency graph, configuration, migrations, and module code remain identical. Runtime behavior is selected by command, for example:

```text
node src/main.ts api
node src/main.ts worker
```

> TODO(human): confirm the exact Node 24 native type-stripping CLI flags used by the selected boilerplate. Node >= 23.6 strips types by default, so explicit experimental flags may be unnecessary.

The in-process event bus cannot be the cross-process backplane because `api` and `worker` are separate OS processes. A domain event emitted in the worker after a monitor threshold breach cannot reach SSE clients connected to the API process through memory. Likewise, an incident update created through the API cannot trigger worker-side notification dispatch in another process through an in-memory bus.

Therefore:

- In-process bus remains for same-process handlers.
- Postgres `LISTEN/NOTIFY` is the cross-process and client-fanout backplane.
- Only events requiring cross-process fanout, SSE, GraphQL subscriptions, public status updates, or notification dispatch are bridged to `NOTIFY`.
- The worker owns partition maintenance: detach and drop expired `check_results` partitions using `CHECK_RESULTS_RETENTION_DAYS`, and prune old `uptime_rollups` using `ROLLUP_RETENTION_DAYS`.

---

## 5. Eventing and real-time

### 5.1 Bus split

| Mechanism | Scope | Use cases | Non-use cases |
|---|---|---|---|
| In-process event bus | Same process only | Local domain reactions, same-command follow-up handlers, decoupled module reactions inside `api` or inside `worker`. | API-to-worker communication, worker-to-API communication, SSE fanout, GraphQL subscription fanout. |
| Postgres `LISTEN/NOTIFY` | Cross-process | API/worker coordination, public SSE, admin GraphQL subscriptions, notification dispatch triggers. | Durable job queue, large payload transport, event store. |

`NOTIFY` payloads are intentionally small. Subscribers re-query read models by `orgId`, `aggregateType`, and `aggregateId` under the appropriate tenant context.

### 5.2 Fanout path

```mermaid
flowchart LR
  A[Command handler commits transaction] --> B[Domain event emitted]
  B --> C[In-process event bus]
  C --> D[NOTIFY bridge handler]
  D --> E[(Postgres channel: watchdog_events)]
  E --> F[LISTEN subscriber in api]
  E --> G[LISTEN subscriber in worker]
  F --> H[Public SSE fanout]
  F --> I[Admin GraphQL subscription fanout]
  G --> J[Notification / background reactions]
```

For public surfaces, the fanout layer gates visibility using the authoritative public set from [DOMAIN.md](./DOMAIN.md). Incident events are public only after name whitelisting and only when the incident is not `draft`; the decision is based on the current read model.

### 5.3 NOTIFY bridge sketch

```ts
type DomainEventName =
  | 'service.status_changed'
  | 'service.created'
  | 'service.updated'
  | 'service.archived'
  | 'service.restored'
  | 'service.manual_override_set'
  | 'service.manual_override_cleared'
  | 'service_group.created'
  | 'service_group.updated'
  | 'service_group.deleted'
  | 'incident.created'
  | 'incident.draft_created'
  | 'incident.confirmed'
  | 'incident.updated'
  | 'incident.update_posted'
  | 'incident.state_changed'
  | 'incident.resolved'
  | 'incident.dismissed'
  | 'maintenance.created'
  | 'maintenance.updated'
  | 'maintenance.started'
  | 'maintenance.completed'
  | 'maintenance.deleted'
  | 'monitor.recovered'
  | 'monitor.threshold_breached'
  | 'monitor.ssl_expiry_warning'
  | 'uptime.rollup_refreshed';

type DomainEvent = {
  name: DomainEventName;
  orgId: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date;
};

const NOTIFY_CHANNEL = 'watchdog_events';

const EVENTS_TO_BRIDGE = new Set<DomainEventName>([
  'service.status_changed',
  'service.created',
  'service.updated',
  'service.archived',
  'service.restored',
  'service.manual_override_set',
  'service.manual_override_cleared',
  'service_group.created',
  'service_group.updated',
  'service_group.deleted',
  'incident.created',
  'incident.draft_created',
  'incident.confirmed',
  'incident.updated',
  'incident.update_posted',
  'incident.state_changed',
  'incident.resolved',
  'incident.dismissed',
  'maintenance.created',
  'maintenance.updated',
  'maintenance.started',
  'maintenance.completed',
  'maintenance.deleted',
  'monitor.recovered',
  'monitor.threshold_breached',
  'monitor.ssl_expiry_warning',
  'uptime.rollup_refreshed',
]);

export async function bridgeDomainEventToNotify(
  sql: import('postgres').Sql,
  event: DomainEvent,
): Promise<void> {
  if (!EVENTS_TO_BRIDGE.has(event.name)) {
    return;
  }

  await sql`
    select pg_notify(
      ${NOTIFY_CHANNEL},
      json_build_object(
        'eventName', ${event.name},
        'orgId', ${event.orgId},
        'aggregateType', ${event.aggregateType},
        'aggregateId', ${event.aggregateId},
        'occurredAt', ${event.occurredAt.toISOString()},
        'version', 1
      )::text
    )
  `;
}
```

The handler for append-only incident timeline updates keys on `incident.update_posted`. No PascalCase event names are used.

### 5.4 LISTEN subscriber sketch

```ts
type WatchdogNotifyPayload = {
  eventName: string;
  orgId: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  version: 1;
};

type RealtimeHub = {
  publishPublic(payload: WatchdogNotifyPayload): Promise<void>;
  publishAdmin(payload: WatchdogNotifyPayload): Promise<void>;
};

const PUBLIC_EVENT_NAMES = new Set<string>([
  'service.status_changed',
  'service.created',
  'service.updated',
  'service.archived',
  'service.restored',
  'service_group.created',
  'service_group.updated',
  'service_group.deleted',
  'incident.created',
  'incident.confirmed',
  'incident.updated',
  'incident.update_posted',
  'incident.resolved',
  'maintenance.created',
  'maintenance.updated',
  'maintenance.started',
  'maintenance.completed',
  'maintenance.deleted',
]);

export async function startWatchdogEventsListener(
  sql: import('postgres').Sql,
  realtimeHub: RealtimeHub,
): Promise<void> {
  await sql.listen('watchdog_events', async rawPayload => {
    const payload = JSON.parse(rawPayload) as WatchdogNotifyPayload;

    await realtimeHub.publishAdmin(payload);

    if (await isPubliclyVisibleEvent(sql, payload)) {
      await realtimeHub.publishPublic(payload);
    }
  });
}

async function isPubliclyVisibleEvent(
  sql: import('postgres').Sql,
  payload: WatchdogNotifyPayload,
): Promise<boolean> {
  if (!PUBLIC_EVENT_NAMES.has(payload.eventName)) {
    return false;
  }

  if (payload.eventName.startsWith('incident.')) {
    const rows = await sql<{ status: string }[]>`
      select status
      from incidents
      where id = ${payload.aggregateId}
        and org_id = ${payload.orgId}
      limit 1
    `;

    return rows[0]?.status !== 'draft';
  }

  return true;
}
```

The visibility rule is name-set intersection draft-gate. `aggregateType` never bypasses the public-name whitelist. This prevents admin-only incident events such as `incident.dismissed` and `incident.state_changed` from leaking simply because their aggregate is no longer in `draft` status. Draft dismissal must emit `incident.dismissed` only and never `incident.resolved`; `incident.resolved` is reserved for confirmed or directly created incidents that resolve through the public lifecycle. `incident.created` needs no special branch: direct human-created incidents pass the draft gate, while monitor-born drafts do not.

### 5.5 SSE handler skeleton

Public status pages use REST for initial state and SSE for live updates.

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type PublicStatusStreamParams = {
  orgSlug: string;
};

export async function registerPublicStatusStreamRoutes(app: FastifyInstance) {
  app.get<{
    Params: PublicStatusStreamParams;
  }>('/status/:orgSlug/events', async (request, reply) => {
    const org = await app.cqrs.queryBus.execute({
      type: 'ResolveOrganizationBySlugQuery',
      slug: request.params.orgSlug,
    });

    return openStatusSseStream(request, reply, org.id);
  });
}

async function openStatusSseStream(
  request: FastifyRequest,
  reply: FastifyReply,
  orgId: string,
): Promise<void> {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const unsubscribe = request.server.realtime.publicEvents.subscribe(
    orgId,
    event => {
      reply.raw.write(`event: ${event.eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
  );

  request.raw.on('close', () => {
    unsubscribe();
  });
}
```

GraphQL subscriptions are admin-only and subscribe to the same API-process realtime hub after Better Auth session and active-org membership checks.

---

## 6. Multi-tenancy enforcement

WatchDog uses a shared PostgreSQL database with tenant isolation by `org_id`. Every WatchDog tenant-scoped table carries `org_id` as a text FK to Better Auth's `organization.id`. Better Auth-owned user, session, account, verification, organization, team, membership, invitation, and role tables sit outside WatchDog tenant-scoped RLS policies.

Enforcement layers:

1. Application code never trusts `orgId` from request input.
2. CQRS middleware resolves active org and role through Better Auth-owned tables.
3. CQRS middleware validates the resolved org id shape against the Better Auth id format before repository work begins; see [Request lifecycle](#3-request-lifecycle).
4. Repository operations run inside transactions.
5. Each transaction sets `SET LOCAL app.current_org_id`.
6. PostgreSQL RLS policies enforce `org_id = current_setting('app.current_org_id', true)`.
7. The app connects as a non-superuser role so RLS cannot be bypassed accidentally.
8. Table owners are not used for normal application traffic; `FORCE ROW LEVEL SECURITY` is enabled on WatchDog tenant tables.

### 6.1 Role provisioning

Role creation is environment-owned, not committed migration SQL with embedded passwords.

- `watchdog_owner` owns schema and runs migrations through the owner `DATABASE_URL`.
- `watchdog_app` is a login, nosuperuser runtime role used by `api`, `worker`, and tests through the app `DATABASE_URL`.
- In Docker Compose, `watchdog_app` is created by a Postgres init script mounted into `/docker-entrypoint-initdb.d/` and parameterized by environment variables.
- In CI, an explicit setup step creates `watchdog_app` with `watchdog_app_test_password` before integration tests.
- Passwords come from environment per environment and are never committed in SQL files.
- Grants may live in migrations, but they should use `ALTER DEFAULT PRIVILEGES` so future WatchDog tables and sequences auto-grant to `watchdog_app`.

Illustrative grant shape for migrations:

```sql
grant usage on schema public to watchdog_app;
grant select, insert, update, delete on all tables in schema public to watchdog_app;
grant usage, select on all sequences in schema public to watchdog_app;

alter default privileges in schema public
grant select, insert, update, delete on tables to watchdog_app;

alter default privileges in schema public
grant usage, select on sequences to watchdog_app;
```

The owner/app URL split is mandatory under `FORCE ROW LEVEL SECURITY`: migrations run as `watchdog_owner`; application traffic runs as `watchdog_app`.

### 6.2 Transaction GUC contract

```sql
begin;

set local app.current_org_id = 'org_123';

-- repository SQL here

commit;
```

`SET LOCAL` is transaction-scoped. It disappears after commit or rollback.

### 6.3 Policy shape

Every WatchDog tenant-scoped table that carries `org_id` uses the same shape. `enable row level security` is immediately followed by `force row level security`.

```sql
alter table service_groups enable row level security;
alter table service_groups force row level security;

create policy service_groups_org_isolation
on service_groups
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table services enable row level security;
alter table services force row level security;

create policy services_org_isolation
on services
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table incidents enable row level security;
alter table incidents force row level security;

create policy incidents_org_isolation
on incidents
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table incident_updates enable row level security;
alter table incident_updates force row level security;

create policy incident_updates_org_isolation
on incident_updates
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table incident_service_impacts enable row level security;
alter table incident_service_impacts force row level security;

create policy incident_service_impacts_org_isolation
on incident_service_impacts
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table maintenance enable row level security;
alter table maintenance force row level security;

create policy maintenance_org_isolation
on maintenance
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table maintenance_services enable row level security;
alter table maintenance_services force row level security;

create policy maintenance_services_org_isolation
on maintenance_services
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table monitors enable row level security;
alter table monitors force row level security;

create policy monitors_org_isolation
on monitors
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table check_results enable row level security;
alter table check_results force row level security;

create policy check_results_org_isolation
on check_results
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table uptime_rollups enable row level security;
alter table uptime_rollups force row level security;

create policy uptime_rollups_org_isolation
on uptime_rollups
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

alter table subscribers enable row level security;
alter table subscribers force row level security;

create policy subscribers_org_isolation
on subscribers
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);
```

### 6.4 Auth tables excluded

Better Auth-owned tables are excluded from WatchDog tenant RLS. They are accessed only through Better Auth integration and explicit pre-tenant reads:

- slug to organization lookup for `/status/:orgSlug`
- authenticated user's organizations for the organization switcher
- active organization membership and role lookup before command/query context construction

After those reads resolve the Better Auth `organization.id`, WatchDog repositories use that id as `app.current_org_id` for tenant-scoped tables.

---

## 7. Auth integration

Better Auth is mounted as a Fastify plugin outside the CQRS bus. Auth is cross-cutting infrastructure, not a WatchDog domain module.

```text
Fastify
  -> Better Auth plugin
  -> auth/session decoration
  -> CQRS context middleware
  -> REST routes / GraphQL resolvers
  -> command/query buses
```

Responsibilities:

| Layer | Responsibility |
|---|---|
| Better Auth plugin | Session, user identity, organization plugin, teams, memberships, invitations, built-in org roles. |
| DBMate migrations | Sole migration source. Better Auth schema is generated, reviewed, committed, and run through DBMate. |
| Session middleware | Reads Better Auth session and attaches actor identity to request. |
| Organization context middleware | Resolves active org, validates org id shape, membership, and Better Auth role. |
| CQRS middleware | Injects `userId`, `orgId`, `orgRole`, and request metadata into command/query context. |
| Repositories | Set `SET LOCAL app.current_org_id` and execute raw SQL under RLS. |

DBMate is the only migration runner. The project must not run Better Auth's migrations independently at runtime.

Workflow:

```text
Generate Better Auth schema
  -> convert/review as DBMate migration
  -> commit migration
  -> run dbmate up in local/CI/container startup workflow
```

> TODO(human): confirm exact Better Auth organization plugin table names and generated FK targets before final migrations are written. Once generated, commit the schema as a DBMate migration and treat that committed file as the FK contract.

RBAC v1 uses Better Auth's built-in organization roles: `owner`, `admin`, and `member`. All three can perform v1 write actions. Finer editor/viewer roles are roadmap.

---

## 8. Compose topology

Services:

| Service | Purpose |
|---|---|
| `postgres` | Primary database, DBMate migrations target, RLS, `LISTEN/NOTIFY` backplane. |
| `mailpit` | Local email sink for notification demos and tests. |
| `migrate` | One-shot migration runner using the owner database URL. |
| `api` | Fastify REST/GraphQL/SSE server using the app database URL. |
| `worker` | Monitor execution, maintenance transitions, uptime rollups, partition maintenance, email dispatch using the app database URL. |

One image is built for `migrate`, `api`, and `worker`; command decides runtime mode.

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: watchdog
      POSTGRES_USER: watchdog_owner
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-watchdog_owner_dev_password}
      WATCHDOG_APP_PASSWORD: ${WATCHDOG_APP_PASSWORD:-watchdog_app_dev_password}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/init/001-create-watchdog-app.sh:/docker-entrypoint-initdb.d/001-create-watchdog-app.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U watchdog_owner -d watchdog"]
      interval: 5s
      timeout: 5s
      retries: 20

  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "1025:1025"
      - "8025:8025"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8025"]
      interval: 5s
      timeout: 5s
      retries: 20

  migrate:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["dbmate", "up"]
    environment:
      DATABASE_URL: postgres://watchdog_owner:${POSTGRES_PASSWORD:-watchdog_owner_dev_password}@postgres:5432/watchdog
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["pnpm", "start:api"]
    environment:
      NODE_ENV: development
      DATABASE_URL: postgres://watchdog_app:${WATCHDOG_APP_PASSWORD:-watchdog_app_dev_password}@postgres:5432/watchdog
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-dev_only_change_me}
      BETTER_AUTH_URL: http://localhost:3000
      SMTP_HOST: mailpit
      SMTP_PORT: "1025"
      WATCHDOG_NOTIFY_CHANNEL: watchdog_events
      PUBLIC_BASE_URL: http://localhost:3000
      LOG_LEVEL: info
      # > TODO(human): confirm final env names used by the boilerplate config loader.
    ports:
      - "3000:3000"
    depends_on:
      migrate:
        condition: service_completed_successfully
      mailpit:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 20

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["pnpm", "start:worker"]
    environment:
      NODE_ENV: development
      DATABASE_URL: postgres://watchdog_app:${WATCHDOG_APP_PASSWORD:-watchdog_app_dev_password}@postgres:5432/watchdog
      SMTP_HOST: mailpit
      SMTP_PORT: "1025"
      WATCHDOG_NOTIFY_CHANNEL: watchdog_events
      MONITORING_POLL_INTERVAL_SECONDS: "10"
      CHECK_RESULTS_RETENTION_DAYS: "30"
      ROLLUP_RETENTION_DAYS: "400"
      LOG_LEVEL: info
      # > TODO(human): confirm final worker scheduler env names.
    depends_on:
      migrate:
        condition: service_completed_successfully
      mailpit:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "src/healthcheck.ts"]
      interval: 10s
      timeout: 5s
      retries: 20

volumes:
  postgres_data:
```

Guessed values are placeholders for local development only. Production-grade secret injection, TLS, backups, and deployment topology are outside this genesis architecture document.

---

## 9. CI

GitHub Actions verifies the backend without deploying it. CI mirrors the Compose owner/app role split: the owner role runs DBMate, and the app role runs tests under `FORCE ROW LEVEL SECURITY`.

Stages:

1. Checkout and install pnpm dependencies.
2. Static checks: Biome formatting/linting, TypeScript checks compatible with native type-stripping, package consistency.
3. Unit tests with `node:test`.
4. Integration tests against a Postgres service container.
5. Create `watchdog_app` with `watchdog_app_test_password`, mirroring the Compose init script.
6. DBMate migration check against the service database as `watchdog_owner`.
7. Integration and Cucumber/Gherkin E2E tests using `watchdog_app`.
8. k6 smoke/load scripts where practical for CI runtime.
9. Docker build validation for the shared image.

```yaml
name: ci

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  check:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_DB: watchdog_test
          POSTGRES_USER: watchdog_owner
          POSTGRES_PASSWORD: watchdog_owner_test_password
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U watchdog_owner -d watchdog_test"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 20

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm check

      - run: pnpm test:unit

      - name: Create app database role
        run: |
          psql "postgres://watchdog_owner:watchdog_owner_test_password@localhost:5432/watchdog_test" <<'SQL'
          do $$
          begin
            if not exists (select from pg_roles where rolname = 'watchdog_app') then
              create role watchdog_app login password 'watchdog_app_test_password' nosuperuser nocreatedb nocreaterole noinherit;
            end if;
          end
          $$;
          SQL

      - name: Run migrations
        run: pnpm dbmate up
        env:
          DATABASE_URL: postgres://watchdog_owner:watchdog_owner_test_password@localhost:5432/watchdog_test

      - run: pnpm test:integration
        env:
          DATABASE_URL: postgres://watchdog_app:watchdog_app_test_password@localhost:5432/watchdog_test
          BETTER_AUTH_SECRET: test_secret
          BETTER_AUTH_URL: http://localhost:3000

      - run: pnpm test:e2e
        env:
          DATABASE_URL: postgres://watchdog_app:watchdog_app_test_password@localhost:5432/watchdog_test
          BETTER_AUTH_SECRET: test_secret
          BETTER_AUTH_URL: http://localhost:3000

      - run: pnpm test:k6:smoke

      - run: docker build -t watch-dog:ci .
```

> TODO(human): align script names with the final `package.json` from the scaffolded boilerplate.

CI does not deploy. Deployment is explicitly outside v1 genesis scope.

---

## Cross-links

- Domain model, entity relationships, RLS policy detail, state machines, status resolution, monitoring persistence, retention, and event catalog: [DOMAIN.md](./DOMAIN.md)
- Product overview, stack table, quickstart, scripts, and repo layout: [README.md](../../README.md)
- Agentic-AI product spec, provider port, prompt/IO shapes, and human-in-the-loop gates: [AI.md](./AI.md)
- v1 definition of done, phased milestones, roadmap, and non-goals: [ROADMAP.md](./ROADMAP.md)
