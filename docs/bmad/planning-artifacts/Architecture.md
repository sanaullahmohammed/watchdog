---
title: WatchDog Architecture
stepsCompleted: []
kind: genesis-adapter
validated: 2026-10-06
---

# WatchDog Architecture

## How to read this document

The architecture of record is `docs/genesis/ARCHITECTURE.md` (runtime wiring, CQRS/module topology, the api/worker split, LISTEN/NOTIFY fanout, SSE and GraphQL subscriptions, RLS enforcement mechanics, Compose, CI) together with `docs/genesis/DOMAIN.md` (entities, ERD, RLS policies, state machines, status-resolution precedence, monitoring persistence, retention, and the canonical event catalog).

This file exists because `bmad-create-epics-and-stories` requires an architecture input. It does not restate those documents. It records which decisions are settled and the constraints that shape every story — so that decomposition treats them as given rather than re-deriving them.

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
| v1 is API-only: no public or admin browser UI | ROADMAP §4 |
| Monitoring runs in the worker and needs no backplane; delivered before real-time | ROADMAP §2, DOMAIN |
| Notifications are derived from durable history into a delivery ledger, at-least-once | ARCHITECTURE §5.6, DOMAIN |

## Already implemented

What is built is tracked in `docs/bmad/implementation-artifacts/sprint-status.yaml` and evidenced by tests. This file lists only settled decisions and the constraints every story inherits.

## Constraints that shape every story

- Every tenant-scoped read or write goes through `withTenantTransaction`. `SET LOCAL` is transaction-scoped; SQL outside a transaction sees nothing.
- An unset `app.current_org_id` reads back as `''` rather than NULL on a connection that has previously set it. A policy must never treat unset as unrestricted.
- Better Auth identifiers are always double-quoted; WatchDog tables stay snake_case.
- Configuration is read only through `src/config/`; env-schema never writes to `process.env`.
- Any new table carrying `org_id` needs RLS enabled, `FORCE`d, and a policy, or the structural test fails.
- A `Cookie` header is not a session. Anything that treats a caller as authenticated resolves the session first.
- Handlers never accept `orgId` from user input. It comes from request context.
- A command handler applies its slice's request schema itself; REST validation is early feedback, not the only check.
- `NOTIFY` payloads carry `{eventName, orgId, aggregateType, aggregateId, occurredAt, version}` and nothing more; subscribers re-query. It is a signal, not a durable bus.

## Data models and API contracts

Entities, fields, constraints, foreign keys, state machines and the event catalog: `docs/genesis/DOMAIN.md`. REST lives under `/api` with TypeBox schemas and Swagger at `/api-docs`; GraphQL is served by Mercurius. Both converge on the same CQRS handlers, as described in ARCHITECTURE §3.

## Definition of done for a story

Beyond its own acceptance criteria, a story is done when `pnpm run check`, `pnpm run test`, `pnpm run test:integration` and `pnpm run auth:schema:check` all pass, any new tenant table has RLS enabled and `FORCE`d with a policy, and any emitted event exists in the DOMAIN catalog.
