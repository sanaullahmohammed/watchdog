---
title: WatchDog Architecture
stepsCompleted: []
---

# WatchDog Architecture

## How to read this document

The architecture of record is `docs/genesis/ARCHITECTURE.md` (runtime wiring, CQRS/module topology, the api/worker split, LISTEN/NOTIFY fanout, SSE and GraphQL subscriptions, RLS enforcement mechanics, Compose, CI) together with `docs/genesis/DOMAIN.md` (entities, ERD, RLS policies, state machines, status-resolution precedence, monitoring persistence, retention, and the canonical event catalog).

This file exists because `bmad-create-epics-and-stories` requires an architecture input. It does not restate those documents. It records which decisions are settled, which are already implemented, and the constraints that shape every story — so that decomposition treats them as given rather than re-deriving them.

## Settled decisions

Do not reopen these during story creation. Each is owned by the document named.

| Decision | Owner |
|---|---|
| Clean Architecture / DDD / CQRS with vertical slices under `src/modules/<feature>/` | ARCHITECTURE §1 |
| Two entrypoints, `api` and `worker`, from one image, selected by command | ARCHITECTURE §4 |
| In-process bus within a process; Postgres `LISTEN/NOTIFY` on `watchdog_events` across processes and to clients | ARCHITECTURE §5 |
| Public status surface is REST plus SSE; admin real-time is GraphQL subscriptions | ARCHITECTURE §5 |
| Shared database, `org_id` row-scoping, RLS with `FORCE`, `SET LOCAL app.current_org_id` | ARCHITECTURE §6, DOMAIN |
| `watchdog_owner` runs migrations; `watchdog_app` serves traffic and is `nosuperuser`, `nobypassrls` | ARCHITECTURE §6.1 |
| Better Auth owns identity, organizations, teams, membership, invitations and the owner/admin/member ladder, outside the CQRS bus | ARCHITECTURE §7 |
| DBMate is the only migration runner, including for the Better Auth schema | ARCHITECTURE §7 |
| Raw SQL through `postgres.js`; no ORM | ARCHITECTURE §1 |
| Better Auth ids are `text`; WatchDog-native primary keys are `uuid`; policies need no `::uuid` cast | DOMAIN |
| Status ladders are `text` with `CHECK` constraints, never Postgres enums | DOMAIN |
| Services are archived, never hard-deleted | DOMAIN |
| Monitor failures create a *draft* incident that a human confirms | DOMAIN |
| `incident.*` events are public only after name whitelisting and only when not `draft` | ARCHITECTURE §5.4 |
| Retention defaults: 30 days of raw check results, 400 days of rollups | DOMAIN |
| All AI output is human-in-the-loop behind a provider port; Azure AI Foundry is one adapter | AI.md |

## Already implemented

Stories must build on these rather than re-plan them.

- **Scaffold and toolchain.** pnpm 12 single package (not a workspace), Biome, k6, `tsx` in development and `tsc` + `resolve-tspaths` for production. `pnpm run check` runs Biome, `tsc --noEmit` and dependency-cruiser.
- **Module boundaries are enforced.** `dependency-cruiser` fails a build where one slice imports another, alongside the inherited layer rules. Cross-module contracts live in `src/shared/events/`.
- **Better Auth schema is frozen.** `db/migrations/*_better_auth_schema.sql` is the FK contract; `pnpm run auth:schema:check` fails if Better Auth expects anything no migration provides. Table names are `"user"`, `"session"`, `"account"`, `"verification"`, `"organization"`, `"team"`, `"teamMember"`, `"member"`, `"invitation"` — all requiring quotes.
- **Runtime topology works.** `docker compose up` runs postgres, mailpit, a one-shot migrate, api and worker, all healthy. `src/index.ts` dispatches on `process.argv[2]`.
- **Roles and grants.** `db/init/001-create-watchdog-app.sh` creates the runtime role; a grants migration uses `ALTER DEFAULT PRIVILEGES` so future tables are covered automatically.
- **Tenant isolation is proven.** `src/shared/db/tenant-transaction.ts` is the helper every repository uses. `service_groups` is the first tenant-scoped table. Twelve integration tests cover cross-tenant read, update, delete, `WITH CHECK`, unscoped reads, pooled-connection reuse and id validation, plus a structural test asserting every `org_id`-carrying table has RLS enabled, `FORCE`d and policied.

## Constraints that shape every story

- Every tenant-scoped read or write goes through `withTenantTransaction`. `SET LOCAL` is transaction-scoped; SQL outside a transaction sees nothing.
- An unset `app.current_org_id` reads back as `''` rather than NULL on a connection that has previously set it. A policy must never treat unset as unrestricted.
- Better Auth identifiers are always double-quoted; WatchDog tables stay snake_case.
- Configuration is read only through `src/config/`; env-schema never writes to `process.env`.
- Any new table carrying `org_id` needs RLS enabled, `FORCE`d, and a policy, or the structural test fails.
- Handlers never accept `orgId` from user input. It comes from request context.
- `NOTIFY` payloads carry `{eventName, orgId, aggregateType, aggregateId, occurredAt, version}` and nothing more; subscribers re-query. It is a signal, not a durable bus.

## Data models and API contracts

Entities, fields, constraints, foreign keys, state machines and the event catalog: `docs/genesis/DOMAIN.md`. REST lives under `/api` with TypeBox schemas and Swagger at `/api-docs`; GraphQL is served by Mercurius. Both converge on the same CQRS handlers, as described in ARCHITECTURE §3.

## Definition of done for a story

Beyond its own acceptance criteria, a story is done when `pnpm run check`, `pnpm run test`, `pnpm run test:integration` and `pnpm run auth:schema:check` all pass, any new tenant table has RLS enabled and `FORCE`d with a policy, and any emitted event exists in the DOMAIN catalog.
