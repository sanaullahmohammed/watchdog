---
title: 'Story 9.13 — SQL debug logging never prints parameter values'
type: 'bugfix'
created: '2026-10-08'
status: 'done'
baseline_commit: 'b3970bc8f7b7fc3507eab34fcef1f8bf89ff4f87'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Query parameter values reach the logs in two ways. Today that means incident titles and messages; from Epic 6 it would mean subscriber email addresses. AI.md 4.4 and ARCHITECTURE 5.6 ("Subscriber addresses never reach logs") forbid this, and Epic 6 may not start until it is fixed (audit F-16).
1. With `LOG_LEVEL=debug`, `src/shared/db/postgres.ts` prints every query's `JSON.stringify(params)` through `console.debug`.
2. At every level, production's included: because `postgres()` always receives a `debug` function, postgres.js makes the `parameters`, `args`, `query` and `types` it attaches to every query error enumerable (`postgres/src/connection.js:403-408`). Each logged database error (`logFailure`'s `{ err }`, the worker's `{ error }`) therefore prints the values.

**Approach:**
- `postgres()` gets `debug: false` unless `LOG_LEVEL` is `debug`. The explicit `false` also beats a `PGDEBUG` variable or a `?debug=` in the URL. This closes leak 2 outside debug mode.
- In debug mode, the hook logs one structured entry per query: connection, trimmed statement and parameter count, never values or types. It logs through a pino logger at the application's level and in its JSON shape, not `console`.
- Every application logger redacts `parameters` and `args` on logged errors (`err.*` and `error.*`). Even in debug mode, an error then prints no values. This goes in one shared list of redact paths, applied by `buildApp` whatever logger options a caller passes, and by the SQL logger.
- The decisions are pure functions in a module that imports no configuration, so unit tests prove them without `.env`.

**Decision:** the SQL entry goes through its own pino instance, not `app.log`. The connection is module-level and exists before any app. It shares the app logger's library, level, format and redaction.

## Boundaries & Constraints

**Always:**
- No parameter value appears in any SQL debug entry, nor in a logged database error, at any level.
- The statement itself may be logged: postgres.js keeps values out of it (`$n` placeholders). The repository uses no `sql.unsafe`.
- `src/shared/db/sql-debug.ts` imports nothing from `@/config`.

**Never:**
- No change to which queries run, or to their text.
- Values inside a Postgres error message or `detail`, such as `invalid input syntax for type integer: "…"` or a unique key, are not addressed here. They are recorded in `deferred-work.md` as an Epic 6 prerequisite.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Parameterized query, debug | statement with an email, a number and a JSON object | one entry `{ connection, statement, parameterCount: 3 }`; none of the values anywhere in it |
| No parameters, debug | a statement with no values | entry with `parameterCount: 0` |
| Not debug | `LOG_LEVEL` info, warn or error | `postgres()` option is `debug: false` |
| Logged error, any level | an error object with `parameters` and `args` logged as `err` or `error` | serialized line holds neither value |
| Caller overrides the logger | `buildApp({ logger: { level } })` (worker, seed) | the redaction still applies |

</frozen-after-approval>

## Code Map

- `src/shared/db/postgres.ts` -- `postgres(env.db.url, { debug: (conn, query, params, paramTypes) => { if (debug) console.debug(... JSON.stringify(params) ...) } })`. `closeDbConnection()` and the default export stay.
- `postgres/src/connection.js:243` calls `debug(id, string, parameters, types)` once per query. Lines 403-408 set the enumerability of the error properties from `options.debug`, and `index.js:472-476` reads `debug` from the options, then the URL, then `PGDEBUG`.
- `src/server/build-app.ts:20-24` -- the Fastify logger: `level: env.log.level`, `redact: ['headers.authorization']`. `...overrides` replaces `logger` whole, so the worker's `buildApp({ logger: { level } })` (`src/worker.ts:157`) and the seed's `buildApp({ logger: { level: 'warn' } })` (`db/seeds/seed.ts:147`) lose the redaction. `logger: false` (a fixture) must stay false.
- Errors are logged at `src/server/error-logging.ts:24` (`{ err: error, correlationId }`) and at `src/worker.ts:51`, `:89` and `:129` (`{ error }`).
- `pino` 10.3.0 is a runtime dependency (`package.json:77`). Its default destination is synchronous stdout, with no worker thread.
- Unit specs run without `.env` in CI.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/db/sql-debug.ts` (new)
  - `LOG_REDACT_PATHS`: `headers.authorization`, `err.parameters`, `err.args`, `error.parameters`, `error.args`.
  - `sqlDebugEntry(connection, statement, parameters)`.
  - `sqlDebugOption(level, makeLogger)` returns `{ debug: false }` unless `level` is `'debug'`; then it returns `{ debug: callback }`, where the callback logs `sqlDebugEntry(...)` with message `'SQL'`.
  - Only type imports.
- [x] `src/shared/db/postgres.ts` -- spread `sqlDebugOption(env.log.level, () => pino({ level: env.log.level, redact: LOG_REDACT_PATHS }))` into the options. Remove the `console.debug` block.
- [x] `src/server/build-app.ts` -- the logger option becomes:
  - the default `{ level: env.log.level, redact: LOG_REDACT_PATHS }`;
  - for an object override, the override merged over that default, with `redact` always `LOG_REDACT_PATHS`;
  - `false` stays `false`.
- [x] `src/shared/db/sql-debug.spec.ts` (new)
  - The two debug rows: distinctive values (`secret-subscriber@example.test`, `987654321`, `{ "token": "abc-xyz" }`) are absent from `JSON.stringify` of everything a fake logger received.
  - The not-debug row for `info`, `warn` and `error`.
  - The logged-error row: a real `pino` writing to an in-memory stream with `redact: LOG_REDACT_PATHS` logs `{ err }` and `{ error }` objects carrying those values, and the output holds none of them.
- [x] `src/server/error-logging.integration.test.ts` (existing) -- one case for the overridden-logger row: a query error with a distinctive parameter, logged through an app built with `buildApp({ logger: { level, stream } })`, holds no value. Reuse that file's log capture if it has one.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- add an entry for values inside Postgres error messages and `detail` (an Epic 6 prerequisite), plus any review finding routed `defer`.

**Acceptance Criteria:**
- Given any matrix row, when exercised, then the outcome matches.
- Given `LOG_LEVEL=debug pnpm run db:seed`, when its lines with `"msg":"SQL"` are read, then they show statements and counts and no value. Check this once by hand.

## Verification

**Commands:**
- `pnpm run check` -- expected: clean.
- `pnpm run test`, then again with `.env` moved aside -- expected: all pass, including `sql-debug.spec.ts`.
- `pnpm run test:integration`, twice -- expected: all pass. Re-run a timeline-order failure; it is this machine's clock.
- `pnpm run test:e2e` -- expected: all scenarios pass.
- `pnpm run auth:schema:check` -- expected: in sync.
- `pnpm run db:seed` -- expected: succeeds, or a no-op.

## Implementation Notes

- `sql-debug.ts` holds the three decisions (`LOG_REDACT_PATHS`, `sqlDebugOption`, `appLoggerOptions`), with type-only imports. `postgres.ts` and `buildApp` only wire them.
- A caller's own `redact` is merged with the shared paths, not replaced. `loggerInstance` is left alone; no caller passes one.
- Review patches applied:
  - The integration test logs errors with enumerable `parameters`/`args` through overridden app loggers, and pins `sql.options.debug === false`.
  - `appLoggerOptions` is unit-tested for every override shape.
- Checked by hand: emptying `LOG_REDACT_PATHS` fails the integration test (6 of 7 pass), and restoring it passes 7 of 7.
- Manual check: under `LOG_LEVEL=debug pnpm run db:seed`, the `"msg":"SQL"` lines show statements with `$n` placeholders and `parameterCount`. None holds the slug or an address.
- Deferred: wrapped or nested database errors and `console.error` paths in debug mode; the AGENTS.md rule; the other Postgres error fields. Values inside Postgres error messages were already deferred.
- Verified: check clean; unit 135/135 with and without `.env`; integration 340/340 twice; e2e 3/3; auth schema in sync; `db:seed` a no-op.

## Spec Change Log

## Review Triage Log

| # | Finding (layer) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | The integration case cannot fail: at `info` postgres.js leaves `parameters`/`args` non-enumerable, so nothing reaches the redactor (blind, gap, edge ×2) | medium | `connection.js:403-408` plus pino's `for…in` serializer; the implementer said so too | patch |
| 2 | `withRedaction` cannot be unit-tested in `build-app.ts`; its instance branch is dead; `loggerInstance` is unhandled; a caller's `redact` is discarded (blind, edge ×3) | medium | Fastify 5.7 rejects an instance as `logger`; the spec asked for pure functions without `@/config` | patch |
| 3 | No test pins `sql`'s real `debug` option (blind) | low | A reordered spread would reopen leak 2 at every level unnoticed | patch |
| 4 | Redaction reaches one level: a wrapped or aggregate database error, or an `ExceptionBase` whose `toJSON` stringifies its `cause`, still prints values in debug mode; so does any key other than `err`/`error` (blind, edge ×3) | medium (unverified) | `DatabaseErrorException` exists but nothing constructs it, so no path wraps a database error today | defer |
| 5 | `console.error` paths (seed failures, the event bus's default reporter) print enumerable values in debug mode (blind, edge) | low | Debug-only; the app's bus uses the app logger | defer |
| 6 | AGENTS.md does not record the rule (log database errors as top-level `err`/`error`; `debug` only through `sqlDebugOption`) (blind) | low | Agent-context file | defer |
| 7 | The deferred entry names only `message` and `detail`; `where`, `hint` and `internal_query` can echo values too (blind) | low | postgres.js copies every server field onto the error | defer |
| 8 | SQL entries carry no `name` binding or request id, use their own stream, and an override with `level: undefined` falls back to info (blind, edge) | low | Debug-only conveniences; no caller passes `level: undefined` | reject |
| 9 | Statuses disagree; notes and triage empty (blind) | false | Step 5 sets review; both are filled at finalization | reject |
