---
title: 'Epic 9 retro item 3 — a second app in one process works, and a duplicate handler fails at boot'
type: 'bugfix'
created: '2026-10-09'
status: 'done'
baseline_commit: '5700fa7fc0a96fccf4a2e34d7fc57f647e1f3725'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-retro-2026-10-08.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `di()` registers every app's handlers in `@fastify/awilix`'s process-wide `diContainer` as singletons. The first app to become ready resolves them, and their `init()` registers them on that app's buses. A second app built in the same process gets fresh buses that stay empty. It answers 500 "Command type of status_page/page.get is not registered" (retro DR-3, deferred 9.2 entry). Separately, `register` on the command and query buses is a `Map.set`, so a second handler for a type silently replaces the first (deferred 9.6 entry).

**Approach:** Each app gets its own awilix container, so its handlers bind to its own buses and closing one app disposes only its own container. With that in place, registering a second handler for a command or query type throws, which turns a collision into a boot failure. ARCHITECTURE 5.1 states both rules first.

## Boundaries & Constraints

**Always:**
- `di()` creates a container per call with awilix's `createContainer({ injectionMode: 'PROXY' })`, the mode the global one uses. It registers on that container and passes it as `container:` to `fastifyAwilixPlugin`. Nothing imports the global `diContainer` any more.
- `register` on the command bus throws an `Error` naming the type when one is already registered. The query bus is built by the same `commandBus()` factory, so it inherits the rule. The event bus keeps many handlers per type by design (ARCHITECTURE 5.1).
- The integration test pins the order DR-3 reproduced: build A, ready A, build B, ready B. Awilix caches a singleton by name on first resolution, and `register` does not clear that cache. So in this order A's ready binds every handler to A's buses, and B's stay empty. Built in the other order, A is the empty one, and the read-through-A row covers that.
- The test asserts `A.diContainer !== B.diContainer`, which fails against the global container in either order.
- The close-A rows guard a half-fix that still shares a cache or a disposal. After A closes, both a read and a command through B must work.
- `signUpWithOrg` runs through A. Its cookie is valid on B, because Better Auth and the database are shared.
- Teardown order: close both apps, so `onClose` drains each event bus. Then delete the org and user. Then end the pool.
- No other process-global state binds to a bus. Resolvers and routes reach the buses through `fastify.commandBus` and `fastify.queryBus`, which are per app. `auth` and `authPool` are shared but call no bus.

**Never:**
- No change to handler files, `makeDependencies`, the event bus, or `@fastify/awilix` options other than `container`.
- No module-level "already built" guard. Two apps in one process are legitimate: two existing suites build them.
- Not moving test helpers. That is item 4. The new test uses `signUpWithOrg` from `src/shared/testing/tenant.ts`.

## I/O & Edge-Case Matrix

| Scenario | State | Expected |
|---|---|---|
| Separate containers | A built and ready, then B | `A.diContainer !== B.diContainer` |
| Read through the second app | org created through A | `GET /status/<slug>` on B answers 200 with the org's page |
| Read through the first app | same | the same request on A answers 200 |
| Command through the second app | B, operator cookie | `POST /api/v1/services` answers 201, and `GET` of that service through B answers 200 |
| First app closed | A closed, B open | `GET /status/<slug>` on B still answers 200, and a second service created through B answers 201 |
| Duplicate handler | one bus, a type registered twice | the second `register` throws, naming the type |

</frozen-after-approval>

## Code Map

- `src/server/di/index.ts:2,9,51-54` -- imports the global `diContainer`, registers on it, and passes it as `container`. This is the fix site.
- `node_modules/@fastify/awilix/lib/fastifyAwilixPlugin.js:7-9,30-34,48-49,77-87` (v8.2.0)
  - The global containers are created at module load.
  - `opts.container` is used when given, and must not be combined with `injectionMode`.
  - The plugin decorates the app with `diContainer`.
  - `onClose` disposes the app's `diContainer`. With the global container, that disposes it for every app.
- Tests already resolve through `app.diContainer` (`incident-detail-read.integration.test.ts:250` and five others), so they follow a per-app container unchanged.
- `src/declarations.d.ts:33-36` -- augments `Cradle` for `@fastify/awilix`. `createContainer()` returns `AwilixContainer<any>`, so add a type only if `tsc` complains.
- `node_modules/awilix/lib/container.js:224,323-333,431-433` -- `register` replaces the resolver but keeps the singleton cache; a singleton is cached on first resolve; `dispose` clears the cache.
- `src/modules/service/commands/recompute-service-status/recompute-service-status.event-handler.ts:144-146` -- an event handler whose `init()` also registers a command. awilix-manager runs `init` once per container, from `onReady` only.
- `src/shared/cqrs/command-bus.ts:13-24` -- `register` ends in `handlers.set(type, handler)`. The query bus is `commandBus()` too (`src/shared/cqrs/index.ts:26`).
- `src/shared/cqrs/event-bus.spec.ts` -- the unit-test style to follow for a new `command-bus.spec.ts`. `command-bus.ts` imports only `ramda` and types, so a unit test needs no config.
- `src/shared/testing/tenant.ts:40-66` -- `signUpWithOrg(app, label)` creates a user and an org with slug `label`, and returns `{ cookie, userId, orgId }`. Cleanup is `delete from "organization"` and `delete from "user"` by id, as `public-surface-bounds.integration.test.ts:61-66` does.
- `src/shared/testing/fixtures.ts:34-41` -- `createService(app, cookie)` posts to `/services`, asserts 201 and returns the id. Use it for the command row.
- `src/server/auth/auth-pool-shutdown.integration.test.ts:26-27` and `src/modules/status-page/public-surface-bounds.integration.test.ts:202` -- hold two apps today and must still pass.
- `docs/genesis/ARCHITECTURE.md:181-185` -- section 5.1, about the event bus. Command and query buses are not described.
- `docs/bmad/implementation-artifacts/deferred-work.md:29-31` (9.2, second app) and `:84-86` (9.6, duplicate register) -- this change closes both.

## Tasks & Acceptance

**Execution:**
- [x] `docs/genesis/ARCHITECTURE.md` 5.1 -- after the event-bus paragraphs, add two rules:
  - The command and query buses hold exactly one handler per type, and registering a second throws at boot.
  - Each app instance owns its buses and its DI container, so its handlers bind to its own buses, and two app instances in one process are independent.
- [x] `src/server/di/index.ts` -- create the container per call and use it in place of the global one.
- [x] `src/shared/cqrs/command-bus.ts` -- `register` throws `Error(\`... type ${type} is already registered\`)` when `handlers.has(type)`.
- [x] `src/shared/cqrs/command-bus.spec.ts` (new) -- registering a type twice throws and names it. The first handler still answers. Distinct types both register.
- [x] `src/server/di/two-apps.integration.test.ts` (new) -- the first five matrix rows, in the order listed, with one organization and a random tag. Teardown as stated in Boundaries.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- remove the two entries this closes. Append any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when its test runs, then the outcome matches.
- Given `di()` reverted to the global container, when the two-app suite runs, then the separate-containers row and every row through B fail.
- Given `register` reverted to a bare `set`, when the unit suite runs, then the duplicate test fails.
- Given the whole application, when every suite boots apps, then no `register` throws, so no two handlers share a type today.

## Implementation Notes

- The implementer started Postgres (`docker compose up -d`) and ran `pnpm run db:migrate` before the integration suite; the stack had stopped.
- Checked by hand with the fixes reverted. Reverting `di()` alone fails all five two-app rows: B's ready re-runs `init` on A's cached singletons, so the new duplicate check throws `service/archive is already registered` at boot. That is the "fails at boot" outcome. Reverting both files restores DR-3: B answers 500 while the read through A passes.
- The review added an event-bus check to the last row: an incident declared through B recomputes the service's status through B. With subscriptions detached (`eventBus.on` a no-op in `di()`), only that assertion fails (`operational` stays `operational`).
- Verified after the review patches: check clean; unit 138/138 with and without `.env`; integration 359/359; e2e 3/3.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | ARCHITECTURE says two apps "are independent", but the Better Auth instance, `authPool` and the postgres.js pool stay process-wide (blind) | low | `auth.ts:47-67`, which holds and releases the pool per app. Direct rewording. | patch |
| 2 | The new 5.1 paragraphs open with "the opposite", which points back two paragraphs, and DI wiring is not eventing (blind) | low | Placement stays in 5.1 next to the event bus rule it contrasts with. The lead-in is reworded. | patch |
| 3 | The duplicate message says "Command type" for a query collision (blind) | low | The query bus is `commandBus()` (`cqrs/index.ts:26`). Direct correction. | patch |
| 4 | A duplicate type is caught only when an app boots, not by `check` or unit tests (blind) | low | Every integration suite boots an app, and AGENTS.md says to run it locally. A static type scan adds machinery for a rare case. | reject |
| 5 | Nothing statically forbids importing the global `diContainer` again (blind) | low | The two-app suite catches it in `di()`. A lint rule for a rare regression adds config. | reject |
| 6 | The per-app container is `AwilixContainer<any>`, so registrations are no longer checked against `Cradle` (blind) | low | `@fastify/awilix/lib/index.d.ts:35` typed the global as `AwilixContainer<Cradle>`. Direct correction. | patch |
| 7 | No row shows B's event handlers subscribed on B's own event bus (blind) | medium | `recompute-service-status.event-handler.ts` subscribes in `init`. A half-fix would pass every row. | patch |
| 8 | Teardown throws on undefined apps after a partial setup, skips the remaining closes, and leaves the user row and the pool behind (edge ×2, blind) | low | `after` calls `a.close()` and `b.close()` unguarded, and deletes by the returned ids only. | patch |
| 9 | `aClosed` is set only after `a.close()` resolves, so a rejected close is retried in `after` (blind) | low | Direct correction. | patch |

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass.
- `pnpm run test:integration` -- expected: all pass. Rerun a failure a few times; WSL2's clock steps back.
- `pnpm run test:e2e` -- expected: all scenarios pass.
- Revert each fix in turn, then run its suite -- expected: the matching cases fail.
