# Epic 9 Context: Stabilization

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epics 2 and 3 built the admin and public surfaces; an audit found they do not hold under input and headers nobody tested. This epic closes those gaps before monitoring, live updates and notifications build on them: GraphQL refuses what REST refuses, the anonymous rate limit cannot be skipped, an admin client can reopen everything it can edit, and the worker's health reports whether it is actually working. It adds no new functional requirement; it re-verifies service and group management, incidents, GraphQL parity and the Compose stack against sharpened verification lines. Delivered before Epics 4 to 8.

## Stories

- Story 9.1: GraphQL refuses what REST refuses, services and groups
- Story 9.2: The anonymous GraphQL limit holds whatever cookie arrives
- Story 9.3: GraphQL refuses what REST refuses, incidents
- Story 9.4: GraphQL refuses what REST refuses, maintenance
- Story 9.5: One slug rule for organizations, at creation and lookup
- Story 9.6: Read service groups
- Story 9.7: Read one incident with its affected services
- Story 9.8: Admin service lists settle ties by id
- Story 9.9: Close Better Auth's pool on shutdown
- Story 9.10: Worker health reports completed passes
- Story 9.11: Every GraphQL mutation runs over GraphQL
- Story 9.12: Public CORS headers on every answer
- Story 9.13: SQL debug logging never prints parameter values
- Story 9.14: The runtime role cannot hard-delete a service

## Requirements & Constraints

- 9.1 to 9.11 must land for the epic to close; 9.12 to 9.14 should land, and 9.13 must land before Epic 6.
- Every GraphQL mutation must refuse each input the REST request schema refuses, with the same `ArgumentInvalidException`, writing and emitting nothing. A GraphQL client sees the message only because it is an `ExceptionBase`; anything else becomes "Internal Server Error".
- Bounds on the anonymous surface must hold for any request without a valid session. A junk, expired or forged `Cookie` is anonymous and rationed; a valid operator session is not. Every GraphQL transport the server accepts is bounded or refused, and a test pins which.
- Creating or changing an organization slug applies the same rule lookup applies: lowercase letters and digits in hyphen-separated runs, at most 120 characters, so every new organization has a reachable public page. Existing organizations keep their slugs.
- A client must be able to read everything it can edit: service groups (ordered by display order, name, id; 404 for another org's id) and one incident with affected services and per-service impact. That response fed back to `updateIncident` must be a no-op.
- Any list whose order is part of a response ends on a unique column. Another admin query found lacking one becomes its own story in its own module.
- Healthchecks fail when the process stops doing its work, not only when it exits; `api` and `worker` and the seed shut down without forcing exit.
- Public-route CORS: every answer (200, 304, 404, 429) carries the headers and exposes `ETag`, with no credentials.
- Database debug logging records the statement and parameter count, never values (incident text now, subscriber addresses from Epic 6).
- Services are archived, never hard-deleted; the runtime role must be refused `DELETE` on `services` while archive and restore keep working.

## Technical Decisions

- Rules have one source: each length, format and range rule is written once, in the slice's TypeBox request schema (or `src/shared/validation/`), and the handler applies it. REST route validation stays as early feedback only. If dependency-cruiser forbids a handler importing its own slice's `.schema.ts`, the rule source moves to the slice's `domain/` and ARCHITECTURE 7.1 is updated.
- The two surfaces stay independently authored (TypeBox for REST, SDL for GraphQL); the parity contract compares names, the behavioural tests compare refusals. Handlers never import `dtos/`; routes and resolvers each apply the same presenter.
- The rate-limit exemption is decided by resolving the session, never by the presence of `Cookie`. The limiter keys on the socket address, `trustProxy` is off, and it must throw a `TooManyRequestsException` (an `ExceptionBase`) or the error handler masks 429 as 500; read `isExceeded`, not `isAllowed`. The convention is added to `AGENTS.md` with the change.
- The slug rule is one function in `src/shared/domain/slug.ts`, called by both Better Auth organization hooks (create and update) and `resolveOrganizationBySlug`.
- Better Auth's `pg` pool is closed by an `onClose` hook after the event bus drains, so `app.close()` releases every connection.
- The worker records when each pass starts and completes; the healthcheck fails once completion is overdue past a configured threshold (in `src/config/env.ts`), with a grace period equal to the threshold at startup. The heartbeat timer alone is not proof of work. Covers every loop the worker runs.
- 9.14 is a new migration revoking `DELETE` on `services` from `watchdog_app`; never edit the applied grant migration.
- Genesis documents already record these decisions; do not edit them to match code. A decision that changes does so in its owning document first.
- Conventions that bite here: Better Auth identifiers are double-quoted, tenant data goes through `withTenantTransaction`, integration tests must not run an unscoped worker pass (pass `{ orgIds }`), and queries ending an order get `id` as the final column. Per-story done means `pnpm run check`, `test`, `test:integration` and `auth:schema:check` pass.

## Cross-Story Dependencies

- 9.1 and 9.2 come first and may run in parallel.
- 9.11 depends on 9.1, 9.3 and 9.4, because its refusal cases need theirs. It is test-only, drives the app over HTTP and imports no module (the exception `src/shared/api/input-validation.integration.test.ts` already makes); it compares its own registry with the merged schema's `Mutation` fields so a new mutation without a case fails.
- 9.3 and 9.4 each record the rules GraphQL failed to apply; where none, they close with one refusal test per rule.
- 9.1, 9.3 and 9.4 are separate stories because no story spans two modules (service, incident, maintenance).
- 9.12 shares `public-surface-bounds.integration.test.ts` with 9.2.
- 9.6 leaves list pagination to Epic 8, which decides it before any list becomes an external contract.
- 9.13 gates Epic 6; the rest of 9.5 to 9.10 and 9.14 are independent.
