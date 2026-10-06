# WatchDog

WatchDog is a self-hosted, multi-tenant status page platform for teams that want Statuspage-style service visibility without handing core operations to a managed SaaS. Organizations manage services, incidents, scheduled maintenance, endpoint monitoring, public status pages, notifications, and human-gated AI assistance from one backend-first application that runs locally through Docker Compose.

## Current status

WatchDog is being built in phases (see [ROADMAP.md](./docs/genesis/ROADMAP.md)). v1 is an API: it serves JSON and GraphQL for an integrator to render, and ships no browser UI. As of 2026-10-06:

- **Runs today:** sign-up, organizations and active-organization switching (Better Auth); services, groups, archive/restore and manual status overrides; incidents with an append-only timeline; scheduled maintenance that starts and completes on time; one effective status per service; the public status payload as JSON at `/status/:orgSlug` and as GraphQL `publicStatusPage`; the admin REST and GraphQL API, with Swagger at `/api-docs`; a demo seed.
- **Planned for v1, not built yet:** synthetic monitoring and draft auto-incidents; 90-day uptime data (the field exists and is empty); live updates over SSE and GraphQL subscriptions; email notifications, RSS/Atom and the subscribe flow; AI assistance.
- **Progress:** [`sprint-status.yaml`](./docs/bmad/implementation-artifacts/sprint-status.yaml).

## v1 scope

### Tenancy/Auth (built)

Multi-tenant organizations, teams, memberships, active-org context, and Better Auth-based authentication; see [ARCHITECTURE.md](./docs/genesis/ARCHITECTURE.md) and [DOMAIN.md](./docs/genesis/DOMAIN.md).

### Services & Status (built)

Service/component management, grouping, archive/restore, and manual status overrides; see [DOMAIN.md](./docs/genesis/DOMAIN.md).

### Incidents & Maintenance (built)

Incident lifecycle, append-only updates, affected services, scheduled maintenance windows, and status transitions; see [DOMAIN.md](./docs/genesis/DOMAIN.md).

### Monitoring (planned)

Synthetic HTTP(S), TCP, keyword-match, and SSL-expiry checks run by the worker, with draft auto-incidents after repeated failures; see [DOMAIN.md](./docs/genesis/DOMAIN.md) and [ARCHITECTURE.md](./docs/genesis/ARCHITECTURE.md).

### Real-time (planned)

Public SSE and admin GraphQL subscriptions receive domain-event fanout through the shared real-time backplane; see [ARCHITECTURE.md](./docs/genesis/ARCHITECTURE.md).

### Public Page (built as JSON; live updates and uptime data planned)

Per-organization public status payload at `/status/:orgSlug`, with live updates and 90-day uptime history to come; see [DOMAIN.md](./docs/genesis/DOMAIN.md).

### Notifications (planned)

Local demoable email through Mailpit, RSS/Atom feeds, and public email subscription flow; see [DOMAIN.md](./docs/genesis/DOMAIN.md) and [ROADMAP.md](./docs/genesis/ROADMAP.md).

### Agentic-AI (planned)

Human-in-the-loop incident copilot, natural-language status-history query, and weekly digest generation behind a provider port; see [AI.md](./docs/genesis/AI.md).

## Stack

| Area | Choice |
|---|---|
| Runtime | TypeScript on Node >= 24, run through `tsx` in development and compiled with `tsc` + `resolve-tspaths` for production |
| Framework | Fastify 5, Awilix DI, Pino logs, Clean Architecture / DDD / CQRS / vertical slices |
| Data | PostgreSQL, raw SQL through `postgres.js`, repository ports/adapters, DBMate migrations and seeds; status values stored as `text` with `CHECK` constraints |
| API | REST under `/api` with TypeBox schemas and Swagger at `/api-docs`; GraphQL through Mercurius |
| Realtime | Public REST + SSE; admin GraphQL subscriptions; Postgres `LISTEN/NOTIFY` for cross-process fanout |
| Auth | Better Auth as a self-hosted Fastify plugin, outside the CQRS bus |
| Testing | `node:test` unit/integration specs beside source, Cucumber/Gherkin E2E, k6 load tests |
| Tooling | pnpm, single package (not a workspace), Biome lint/format, OpenTelemetry off by default |
| Packaging | Multi-stage Alpine Dockerfile, non-root runtime, healthcheck, Docker Compose |

## Architecture at a glance

WatchDog follows the backend boilerplate's Clean Architecture, DDD, CQRS, functional-programming, and vertical-slice conventions. Feature code lives under `src/modules/<feature>/`, and modules do not import each other directly; cross-module request/response work goes through command/query buses, while fire-and-forget work goes through events. The runtime uses two entrypoints from one image: `api` serves REST, GraphQL, auth, and real-time clients, while `worker` runs maintenance transitions and status reconciliation today, and takes on monitoring, rollups, retention and notification work as those phases land. The in-process event bus remains useful inside a single process, but `api` and `worker` do not share memory, so cross-process and client fanout uses Postgres `LISTEN/NOTIFY` as the backplane. Tenant isolation is shared-database, row-scoped by `org_id`, and Postgres RLS is the tenant boundary: no repository adds its own `org_id` predicate, so `api` and `worker` refuse to start as a role RLS does not bind.

For the full architecture, see [ARCHITECTURE.md](./docs/genesis/ARCHITECTURE.md).

## Quickstart

```bash
git clone https://github.com/sanaullahmohammed/watchdog.git
cd watchdog

corepack enable
pnpm install
pnpm run create:env

docker compose up
```

`docker compose up` runs Postgres, Mailpit, the one-shot `migrate` service, `api`, and `worker` from a single image. Migrations run through `migrate` before `api` and `worker` start, so the Compose path needs no separate local migration command and does not start a second server on port 3000.

Once the stack reports healthy:

```bash
curl http://localhost:3000/live      # liveness, from @gquittet/graceful-server
curl http://localhost:3000/ready     # readiness
open http://localhost:3000/api-docs  # Swagger
open http://localhost:8025           # Mailpit
```

### Run the API locally against Compose Postgres

Use this variant when developing the API process outside Compose while still using Compose for dependencies:

```bash
docker compose up postgres mailpit migrate

# In a separate shell. Configuration comes from .env; env-schema validates it
# and fails fast naming any missing variable.
pnpm run dev:api
```

Script names, confirmed against the scaffold:

| Script | Does |
|---|---|
| `pnpm run create:env` | Copies `.env.example` to `.env`, failing if one exists |
| `pnpm run dev` / `dev:api` / `dev:worker` | Watch mode; bare `dev` defaults to the `api` entrypoint |
| `pnpm run build` | `tsc` to `dist`, then `resolve-tspaths` rewrites the `@/*` alias |
| `pnpm run start:api` / `start:worker` | Production entrypoints over `dist` |
| `pnpm run check` | Biome format + lint, `tsc --noEmit`, dependency-cruiser |
| `pnpm run test` / `test:unit` | `node:test` specs beside source; no database required |
| `pnpm run test:integration` | Tenant-isolation suite; needs a migrated database and a `DATABASE_URL` pointing at `watchdog_app` |
| `pnpm run test:e2e` | Cucumber scenarios in `tests/`, against a live server on a free port and a migrated database. Each scenario builds its own organization through the API and removes it afterwards; none reads the seed |
| `pnpm run test:k6:smoke` / `test:k6:load` | k6 profiles in `tests/load` |
| `pnpm run db:migrate` | DBMate, reading `DBMATE_DATABASE_URL` rather than `DATABASE_URL` |
| `pnpm run db:seed` | Creates a demo organization, `acme-demo`, through the application's own commands and prints the sign-in. A second run is a no-op; refuses under `NODE_ENV=production` |
| `pnpm run auth:schema:check` | Fails if Better Auth expects schema no migration provides |

Configuration is read only through `src/config/env.ts`. env-schema validates `.env` and returns an object; it never writes to `process.env`, so a module reading `process.env` directly sees nothing from `.env`.

## Repo layout

```text
watchdog/
├── .github/
│   └── workflows/
├── db/
│   ├── init/          # role bootstrap, run once by the postgres container
│   ├── migrations/
│   └── seeds/         # demo organization, written through commands
├── docs/
│   └── genesis/
│       ├── AI.md
│       ├── ARCHITECTURE.md
│       ├── DOMAIN.md
│       ├── public-status-wireframe.md
│       └── ROADMAP.md
├── scripts/           # auth schema drift check
├── biome.json
├── docker-compose.yml
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── README.md
├── src/
│   ├── modules/
│   │   ├── service/
│   │   ├── incident/
│   │   ├── maintenance/
│   │   └── status-page/       # planned: monitoring/, notification/, ai/
│   ├── server/
│   │   └── auth/              # Better Auth instance, active-org and role resolution
│   ├── shared/                # tenant transactions, cross-module event contracts
│   └── ...
├── tests/
│   ├── load/          # k6 smoke + load profiles
│   ├── support/       # Cucumber world and hooks
│   └── ...
```

`auth` is not a domain module. It is implemented as a Better Auth Fastify plugin plus CQRS context middleware.

Confirmed after scaffolding. `pnpm-workspace.yaml` carries pnpm >= 12 settings only; it declares no `packages:` key, so this stays a single package.

## Scope & non-goals

- v1 targets a single-compose, backend-first portfolio implementation covering tenancy, services, incidents, maintenance, monitoring, public status pages, notifications, real-time, AI assistance, tests, and CI. See [Current status](#current-status) for what exists today.
- WatchDog does not use an ORM, a second migration runner, serverless hosting, or managed auth SaaS.
- v1 does not include a browser UI (public or admin), editor/viewer RBAC, Slack/SMS/webhooks, subdomain or custom-domain routing, multi-region checks, public API, status badges, hard service deletion, or autonomous AI posting.
- AI features are human-in-the-loop; WatchDog does not autonomously publish customer-facing incident content.

For phased delivery and non-goals, see [ROADMAP.md](./docs/genesis/ROADMAP.md).

## Documentation index

- [ARCHITECTURE.md](./docs/genesis/ARCHITECTURE.md) - CQRS/DDD mapping, entrypoints, eventing, real-time fanout, Compose topology, auth plugin, RLS mechanics, and CI shape.
- [DOMAIN.md](./docs/genesis/DOMAIN.md) - entities, relationships, multi-tenant data model, RLS sketch, state machines, status-resolution rules, uptime storage, rollups, retention, and event catalog.
- [AI.md](./docs/genesis/AI.md) - agentic product capabilities, provider-port contract, prompt and IO shapes, human gates, v1 AI scope, and MCP roadmap note.
- [ROADMAP.md](./docs/genesis/ROADMAP.md) - milestones, v1 definition of done, ordered roadmap items, and explicit non-goals.
- [public-status-wireframe.md](./docs/genesis/public-status-wireframe.md) - throwaway sketch of the public status page, kept as the record of what the `/status/:orgSlug` payload was designed against.
