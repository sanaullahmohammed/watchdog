---
title: 'Story 9.9 — Close Better Auth''s pool on shutdown'
type: 'bugfix'
created: '2026-10-07'
status: 'done'
baseline_commit: 'bbb19851d23e003d7b24910e2079fee3dd544ab4'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Better Auth's `pg` pool is never closed. `app.close()` leaves its connections open, so the seed forces `process.exit()` to get out (audit F-07). ARCHITECTURE section 7 already states the contract: "an `onClose` hook ends it after the event bus drains, so `app.close()` releases every connection the process holds, and no entrypoint or script forces exit to escape an open pool".

**Approach:**
- Name the pool in `auth.ts` and give it a small holder count. Each built app holds it; its `onClose` first drains the event bus, then releases its hold. The last release ends the pool.
- The seed ends the pool itself in its `finally`, because its no-op path never builds an app, and drops `process.exit()`.

**Decisions (owner, 2026-10-07):**
- The worker drops its `process.exit(0)` after shutdown (`src/worker.ts:168`) and exits on its own. Spawning a real worker in a test would run an unscoped maintenance pass, which AGENTS.md forbids. Its clean exit is therefore checked by hand before presenting; no automated test covers it.
- The api passes `syncClose: true` to graceful-server, so `fastify.close()` (which drains the bus and ends the auth pool) finishes before `closeDbConnection()` starts. graceful-server's own `process.exit` stays; it is the library's.

## Boundaries & Constraints

**Always:**
- The pool ends only after the event bus has drained. The auth plugin's `onClose` awaits `fastify.eventBus.drain()` itself, rather than relying on the order Fastify runs `onClose` hooks in.
- Ending is idempotent: a second end awaits the first, never pg's "Called end on pool more than once". pg-pool sets `ending` at once and `ended` only when the last client is gone, so the guard is a memoized end promise, not `ended`.
- Another app open in the same process keeps the pool alive. `public-surface-bounds.integration.test.ts` closes a second app mid-file while the first still serves.
- Building an app after the pool has ended or is ending throws a clear error naming the cause, rather than failing later on a dead pool. So every process builds its apps while at least one is open, or builds only one. Cucumber therefore moves to one app per process.
- The seed keeps `process.exitCode = 1` on error, and ends the auth pool even if closing postgres.js throws.

**Never:**
- No per-app Better Auth instance. `resolveActor`, `organization-context` and the seed import the module singleton, and the Better Auth CLI loads `auth.ts` standalone.
- No change to the auth configuration, schema, or `db/better-auth-schema.sql`.

## I/O & Edge-Case Matrix

| Scenario | State | Expected |
|---|---|---|
| Close after use | app built, a sign-up served | after `app.close()`: pool `totalCount` 0 and ended |
| After drain | an async event handler still running at `close()` | the handler sees the pool open; it is ended only afterwards |
| Two apps | two apps built, one closed | the pool stays usable through the other; closing the last ends it |
| Rebuild after end | pool ended, then `buildApp()` | throws an error that names the ended auth pool |
| Seed | first run (`acme-demo` absent); the no-op path never touches the auth pool | exits on its own, promptly; pg's idle timeout would otherwise hold it about 10 s. Checked by hand (Verification) |
| Cucumber | `pnpm run test:e2e`, three scenarios in one process | all pass on one shared app |

</frozen-after-approval>

## Code Map

- `src/server/auth/auth.ts:44-45`
  - `export const auth = betterAuth({ database: new Pool({ connectionString }) , … })`: a process-wide singleton. The pool is anonymous, and nothing ends it.
  - The CLI imports this file by relative path, so keep it free of `@/` imports.
- `src/server/plugins/auth.ts:66-79` -- `fp(authPlugin, { name: 'auth' })`: decorates `auth` and mounts `/api/auth/*`. It has no hooks.
  - Load order between `auth.ts` and `cqrs.ts` is not guaranteed: autoload reads the directory unsorted, and avvio runs `onClose` hooks last-in, first-out. Hence the self-drain.
  - `fastify.eventBus` exists by the time `onClose` runs, because both are `fp` on the root instance. A second `app.close()` does not re-run `onClose`.
- `src/shared/cqrs/index.ts:36-42` -- the cqrs `onClose` that calls `eventBusInstance.drain()`. `drain()` is a no-op when nothing is running (`src/shared/cqrs/event-bus.ts:113`).
- `db/seeds/seed.ts`
  - Calls the auth API (:103, :137) before `buildApp()` (:147).
  - The no-op path returns at :131, before any app exists.
  - The ending at :270-278 has `closeDbConnection()`, then `process.exit()`.
- `src/modules/status-page/public-surface-bounds.integration.test.ts:39,175,291` -- the only integration file with two `buildApp()` calls. A second app is closed while the first still serves.
- `tests/support/common-hooks.ts:20-50` -- cucumber's `Before` builds and listens an app per scenario, and its `After` closes it. CI runs `test:e2e` (`.github/workflows/ci.yml:117`). Each scenario already creates and deletes its own organization.
- `node_modules/.pnpm/pg-pool@*/node_modules/pg-pool/index.js:486-497` -- `end()` rejects if `ending`; `ended` is set later.
- A `buildApp()` that throws after the auth plugin registered leaks its hold. That is harmless today: no caller survives a failed build except the seed, which ends the pool itself.
- `src/worker.ts:148-172` -- `shutdown()` clears both intervals and awaits the pass in flight. It then calls `app.close()` and `closeDbConnection()`, and finally `process.exit(0)`. The heartbeat and maintenance intervals are its ref'd handles; both are cleared there. Under-pressure's timers are unref'd.
- `src/api.ts:18-24` -- `GracefulServer(fastify.server, { closePromises: [() => fastify.close(), closeDbConnection] })`. Without `syncClose`, graceful-server runs these with `Promise.allSettled(map)`, in parallel (`node_modules/@gquittet/graceful-server/lib/core/improvedServer.cjs`, default `syncClose: false` in `lib/config/index.cjs`).
- `node --test` runs each test file in its own process, so a file that ends the pool affects only itself.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/auth/auth.ts` -- `export const authPool = new Pool(...)`, passed to `betterAuth`.
  - `holdAuthPool()` throws if the pool has ended.
  - `releaseAuthPool()` decrements the count and ends the pool at zero.
  - `endAuthPool()` is idempotent.
  - A short comment gives the reason.
- [x] `src/server/plugins/auth.ts` -- call `holdAuthPool()` at registration. Add an `onClose` that awaits `fastify.eventBus.drain()`, then `releaseAuthPool()`.
- [x] `db/seeds/seed.ts` -- in `finally`, close postgres.js and `endAuthPool()` so that one failing does not skip the other (`try/finally` or `Promise.allSettled`). Remove `process.exit()` and its comment.
- [x] `tests/support/common-hooks.ts` -- build and listen one app in `BeforeAll` and close it in `AfterAll`. Each scenario's `Before` points `this.server`/`this.baseUrl` at the shared app and keeps its own `this.db`. Its `After` keeps its organization cleanup and stops closing the app. Check `tests/support/` for anything else that closes `this.server`.
- [x] `src/worker.ts` -- remove `process.exit(0)`. Its comment says the process now ends once every handle has closed.
- [x] `src/api.ts` -- add `syncClose: true`, and update the comment: the steps run in order only because of it.
- [x] `src/server/auth/auth-pool-shutdown.integration.test.ts` -- one ordered scenario, because a pool cannot reopen in its process.
  1. Build apps A and B, and sign up through A.
  2. Close B; a sign-in through A still works.
  3. Register a handler on a test-only event type on A. It waits about 100 ms, then runs `authPool.query('select 1')` and records success. Emit it.
  4. Close A. The handler's query succeeded, and the pool is now `ended` with `totalCount` 0.
  5. `buildApp()` rejects with the ended-pool error.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- append any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when exercised, then the outcome matches.
- Given the full integration suite, when run, then every file still passes, including `public-surface-bounds`.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass. Unit specs must not import `auth.ts` at runtime.
- `pnpm run test:integration`, twice -- expected: all pass. Re-run a timeline-order failure; it is this machine's clock.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run test:e2e` -- expected: all scenarios pass. CI runs it, so run it locally for this story.
- `pnpm run db:seed` -- expected: returns to the prompt promptly with no forced exit.

**Manual checks:**
- Seed first run: only with the owner's consent, delete the local `acme-demo` organization and its operator user, then time `pnpm run db:seed`. Expected: it re-creates them and exits in well under 10 s after its last line. Without consent, record that the first-run path was not exercised.
- Run the worker with `node --import tsx src/index.ts worker` against the development database. When it logs "Worker is ready", send SIGTERM. Expected: it logs its shutdown and the process exits with code 0 within a few seconds, without `process.exit`.

## Implementation Notes

- Review patches applied: the api logs a failed `fastify.close()` rather than letting it skip the database close and graceful-server's exit; a spawned fixture proves a process exits on its own after closing the app and postgres.js (it times from a `closed` line to exit, < 5 s, because startup under the full suite exceeded a fixed 8 s bound); the shutdown test cleans up its user and closes both apps in `finally`; cucumber's `AfterAll` tolerates a failed `BeforeAll`; the seed's comment gives the real reason for `endAuthPool()`.
- The fixture opens one auth connection first: `pg.Pool` is lazy, so without it the test passed with the release removed. With the release commented out, it fails at about 10 s (pg's idle timeout); checked by hand.
- Manual worker check: started against the development database, SIGTERM after "Worker is ready". It logged "Worker is shutting down" and exited with code 0 in 0.07 s, without `process.exit`.
- Seed first-run path not exercised: the owner did not consent to resetting the local `acme-demo`. The no-op run exits on its own in 2.2 s.
- Verified: check clean; unit 111/111 with and without `.env`; integration 278/278 twice; e2e 3/3 scenarios; auth schema in sync.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | With `syncClose`, a rejected `fastify.close()` skips `closeDbConnection` and graceful-server's exit, so the api hangs; the comment also misstates graceful-server's order (blind, gap, edge ×2) | medium | `improvedServer.cjs`: `if (syncClose) for (const i of s) await i()` with no catch, then the socket close and `exit` | patch |
| 2 | Nothing proves a process exits once it closes the app and postgres.js, which the worker and seed now rely on (gap, blind) | medium | No test runs a shutdown path without `process.exit`; spawning the real worker would run an unscoped pass | patch |
| 3 | The new test never deletes its user, and leaves both apps open if an assertion fails first (blind, edge) | low | `auth-pool-shutdown.integration.test.ts` has no cleanup and no `finally` | patch |
| 4 | Cucumber's `AfterAll` hides a `BeforeAll` failure behind a TypeError (blind, gap, edge) | low | `sharedApp.close()` on `undefined` | patch |
| 5 | The seed's comment gives the wrong reason for `endAuthPool()` (blind) | low | The no-op path returns before any `auth.api` call; `pg.Pool` connects lazily | patch |
| 6 | ARCHITECTURE section 7 says no entrypoint forces exit, though graceful-server exits the api; neither it nor AGENTS.md records that the auth pool is process-wide and refuses a build after the last close (blind) | medium | `ARCHITECTURE.md:782`; the new constraint binds every test author | defer |
| 7 | The api's ordered shutdown (`syncClose`) has no test (gap) | medium | Proving it needs a spawned api with a handler in flight at SIGTERM | defer |
| 8 | The worker has no backstop if a handle lingers, and a second signal is swallowed (blind, edge) | low | The `shuttingDown` guard predates this story; #2's test covers lingering handles from the app | reject |
| 9 | The auth `onClose` skips release if `drain()` throws or `eventBus` is missing (edge) | false | `drain()` awaits tracked promises that already catch (`event-bus.ts:57-62`); without cqrs no app builds | reject |
| 10 | A rejected `authPool.end()` is cached; `endAuthPool()` while held ends the pool under live apps; `Math.max` hides an unbalanced release (edge, blind) | low | pg's `end()` does not reject in practice; only the seed calls `endAuthPool()`, after its app closed; release happens only in `onClose` | reject |
| 11 | Shared cucumber app keeps rate-limit buckets and handlers across scenarios (blind, gap, edge) | low | Three scenarios today, well under 120 per minute; each scenario owns its organization | reject |
| 12 | The test may pass without the plugin's own `drain()` if cqrs's hook runs first; it uses a fixed 100 ms wait (blind) | low | The self-drain is defensive by design (spec Always); onClose order is not fixed | reject |
| 13 | No test of a build during another app's drain, or of `endAuthPool()` after the pool ended (blind) | low | Neither path is used by any caller except the seed's second call, which the memoized promise covers | reject |
