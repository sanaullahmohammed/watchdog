# WatchDog

WatchDog is a self-hosted, multi-tenant status page platform for teams that want Statuspage-style service visibility without handing core operations to a managed SaaS. Organizations manage services, incidents, scheduled maintenance, endpoint monitoring, public status pages, notifications, and human-gated AI assistance from one backend-first application that runs locally through Docker Compose.

## Features

### Tenancy/Auth

Multi-tenant organizations, teams, memberships, active-org context, and Better Auth-based authentication; see [ARCHITECTURE.md](./ARCHITECTURE.md) and [DOMAIN.md](./DOMAIN.md).

### Services & Status

Service/component management, grouping, archive/restore, and manual status overrides; see [DOMAIN.md](./DOMAIN.md).

### Incidents & Maintenance

Incident lifecycle, append-only updates, affected services, scheduled maintenance windows, and status transitions; see [DOMAIN.md](./DOMAIN.md).

### Monitoring

Synthetic HTTP(S), TCP, keyword-match, and SSL-expiry checks run by the worker, with draft auto-incidents after repeated failures; see [DOMAIN.md](./DOMAIN.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

### Real-time

Public SSE and admin GraphQL subscriptions receive domain-event fanout through the shared real-time backplane; see [ARCHITECTURE.md](./ARCHITECTURE.md).

### Public Page

Per-organization public status pages at `/status/:orgSlug` with live updates and 90-day uptime history; see [DOMAIN.md](./DOMAIN.md).

### Notifications

Local demoable email through Mailpit, RSS/Atom feeds, and public email subscription flow; see [DOMAIN.md](./DOMAIN.md) and [ROADMAP.md](./ROADMAP.md).

### Agentic-AI

Human-in-the-loop incident copilot, natural-language status-history query, and weekly digest generation behind a provider port; see [AI.md](./AI.md).

## Stack

| Area | Choice |
|---|---|
| Runtime | TypeScript on Node >= 24 with native type-stripping; no build step or transpiler |
| Framework | Fastify 5, Awilix DI, Pino logs, Clean Architecture / DDD / CQRS / vertical slices |
| Data | PostgreSQL, raw SQL through `postgres.js`, repository ports/adapters, DBMate migrations and seeds; status values stored as `text` with `CHECK` constraints |
| API | REST under `/api` with TypeBox schemas and Swagger at `/api-docs`; GraphQL through Mercurius |
| Realtime | Public REST + SSE; admin GraphQL subscriptions; Postgres `LISTEN/NOTIFY` for cross-process fanout |
| Auth | Better Auth as a self-hosted Fastify plugin, outside the CQRS bus |
| Testing | `node:test` unit/integration specs beside source, Cucumber/Gherkin E2E, k6 load tests |
| Tooling | pnpm monorepo, Biome lint/format, OpenTelemetry off by default |
| Packaging | Multi-stage Alpine Dockerfile, non-root runtime, healthcheck, Docker Compose |

## Architecture at a glance

WatchDog follows the backend boilerplate's Clean Architecture, DDD, CQRS, functional-programming, and vertical-slice conventions. Feature code lives under `src/modules/<feature>/`, and modules do not import each other directly; cross-module request/response work goes through command/query buses, while fire-and-forget work goes through events. The runtime uses two entrypoints from one image: `api` serves REST, GraphQL, auth, and real-time clients, while `worker` runs background monitoring, maintenance transitions, rollups, retention, and notification work. The in-process event bus remains useful inside a single process, but `api` and `worker` do not share memory, so cross-process and client fanout uses Postgres `LISTEN/NOTIFY` as the backplane. Tenant isolation is shared-database, row-scoped by `org_id`, with Postgres RLS as defense in depth.

For the full architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Quickstart

```bash
npx degit marcoturi/fastify-boilerplate watch-dog
cd watch-dog

corepack enable
pnpm install
pnpm create:env

docker compose up
```

`docker compose up` is expected to run Postgres, Mailpit, the one-shot `migrate` service, `api`, and `worker`. Migrations run inside Compose through the `migrate` service before `api` and `worker` start, so the Compose path does not need a separate local migration command and does not start a second server on port 3000.

### Run the API locally against Compose Postgres

Use this variant when developing the API process outside Compose while still using Compose for dependencies:

```bash
docker compose up postgres mailpit migrate

# In a separate shell, after confirming the scaffolded script name:
DATABASE_URL=postgres://watchdog_app:watchdog_app_dev_password@localhost:5432/watchdog \
BETTER_AUTH_URL=http://localhost:3000 \
pnpm run dev:api
```

> TODO(human): Confirm whether `pnpm create:env`, `pnpm run dev:api`, `pnpm dbmate up`, and the final Compose command names are the exact script names inherited from the boilerplate.

## Repo layout

```text
watch-dog/
├── .github/
│   └── workflows/
├── db/
│   ├── init/
│   ├── migrations/
│   └── seeds/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
├── README.md
├── src/
│   ├── modules/
│   │   ├── organization/
│   │   ├── service/
│   │   ├── incident/
│   │   ├── maintenance/
│   │   ├── monitoring/
│   │   ├── notification/
│   │   ├── ai/
│   │   └── status-page/
│   └── ...
├── tests/
│   └── ...
├── ARCHITECTURE.md
├── DOMAIN.md
├── AI.md
└── ROADMAP.md
```

`auth` is not a domain module. It is implemented as a Better Auth Fastify plugin plus CQRS context middleware.

> TODO(human): Confirm the exact boilerplate top-level folders after scaffolding.

## Scope & non-goals

- v1 is a single-compose, backend-first portfolio implementation covering tenancy, services, incidents, maintenance, monitoring, public status pages, notifications, real-time, AI assistance, tests, and CI.
- WatchDog does not use an ORM, a second migration runner, serverless hosting, or managed auth SaaS.
- v1 does not include editor/viewer RBAC, Slack/SMS/webhooks, subdomain or custom-domain routing, multi-region checks, public API, status badges, hard service deletion, or autonomous AI posting.
- AI features are human-in-the-loop; WatchDog does not autonomously publish customer-facing incident content.

For phased delivery and non-goals, see [ROADMAP.md](./ROADMAP.md).

## Documentation index

- [ARCHITECTURE.md](./ARCHITECTURE.md) - CQRS/DDD mapping, entrypoints, eventing, real-time fanout, Compose topology, auth plugin, RLS mechanics, and CI shape.
- [DOMAIN.md](./DOMAIN.md) - entities, relationships, multi-tenant data model, RLS sketch, state machines, status-resolution rules, uptime storage, rollups, retention, and event catalog.
- [AI.md](./AI.md) - agentic product capabilities, provider-port contract, prompt and IO shapes, human gates, v1 AI scope, and MCP roadmap note.
- [ROADMAP.md](./ROADMAP.md) - milestones, v1 definition of done, ordered roadmap items, and explicit non-goals.
