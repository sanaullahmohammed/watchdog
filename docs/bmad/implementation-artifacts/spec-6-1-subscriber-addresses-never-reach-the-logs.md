---
title: 'Story 6.1 — Subscriber addresses never reach the logs'
type: 'bugfix'
created: '2026-10-21'
status: 'done'
baseline_commit: '88fef8863e392a38120da01c91759f3aca44a7cd'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/docs/bmad/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A logged database error still prints the values it carries. postgres.js copies every Postgres error field onto the error as an enumerable property, so `message`, `detail`, `where`, `hint` and `internal_query` print (a unique violation's `detail` is `Key (email)=(...) already exists`). pino's `err` serializer folds a `cause`'s message into the parent's, copies `AggregateError` members without scrubbing them, and `logFailure` repeats an error's message as the line's `msg`, as pino itself does for an error passed bare (`src/api.ts`, `src/worker.ts`). An error under any other key reaches `JSON.stringify` unserialized. `ExceptionBase.toJSON` stringifies its `cause` raw, and the event bus's default reporter and the seed print through `console.error`. ARCHITECTURE 5.6 requires all of this fixed before any subscriber address is stored. These are `deferred-work.md`'s two "Epic 6 prerequisite" entries.

**Approach:** One recursive error serializer, applied as both `err` and `error` by every logger the application builds, plus a `logMethod` hook that serializes an error passed bare or under any other top-level key and never lets a database error's message become `msg`. It redacts a database error's value-bearing fields at any depth: top level, under a property, in an `AggregateError`, or as a `cause`. Its code, constraint, table, routine and stack still print. `logFailure`, `ExceptionBase.toJSON`, the event bus's default reporter and the seed all go through it.

**Decision (owner, 2026-10-21):**
- A malformed JSON body's parse error quotes about 10 characters of the body, e.g. `..."{"email": alice@exam"... is not valid JSON`. So for Fastify's own request refusals, `logFailure` logs the error's `code` (e.g. `FST_ERR_CTP_INVALID_JSON_BODY`) instead of its message. The response is unchanged.
- The full spec is kept, at about 2,400 tokens after review.

## Boundaries & Constraints

**Always:**
- A *database error* is any error-like value with a string `severity` and a `code` matching `/^[0-9A-Z]{5}$/`. That covers postgres.js's `PostgresError` and `pg`'s `DatabaseError` (Better Auth's pool).
- Redacted as `'[Redacted]'`:
  - on a database error: `message`, `detail`, `where`, `hint`, `internal_query` and `internalQuery`, plus that message inside its stack. Replace the exact message string, which may span lines; never assume the stack's header name (`pg`'s errors are named `error`);
  - on any error, at any depth: `parameters` and `args`.
- Every other field prints, including the rest of the stack. The output keeps pino's shape: `type`, `message`, `stack`, then the other own enumerable properties. A non-database error, such as postgres.js's `CONNECTION_REFUSED`, prints unchanged.
- A line's `msg` is never a database error's message. Where it would be (a bare error, or `{ err }` with no message), it is `Database error <code>`.
- `logFailure` logs a 4xx whose `code` starts `FST_ERR_` with that code as `msg`. That covers the malformed body and `FST_ERR_BAD_URL` (`src/server/framework-errors.ts`).
- A cause is serialized as its own scrubbed object under `cause`, never folded into the parent's message or stack. `AggregateError` members go under `aggregateErrors`. A cycle is safe, and nesting stops at depth 8.
- The scrub is pure and lives in `src/shared/db/sql-debug.ts`, which imports nothing from `@/config`. `LOG_REDACT_PATHS` stays.
- Fastify keeps its `req` and `res` serializers. A caller's own serializers are kept, but `err` and `error` are always the scrub.
- Tests capture log lines through a helper in `src/shared/testing/` (Constraint 9). Each redaction's test is shown to fail with that redaction reverted (Constraint 11).

**Never:**
- No change to any HTTP or GraphQL response, any query, or any log level.
- Not covered: a message the application composes from a database error's text. Nothing does that today, and story 6.3 must not start.
- Better Auth's own logger is not touched. It never sees a subscriber address.
- GraphQL's own 4xx messages, which can quote a variable's value, are not changed. Subscribe, confirm and unsubscribe are REST only (ARCHITECTURE 7.1), so no address is a GraphQL argument.
- Not covered: request URLs in Fastify's request log, uncaught-exception output on stderr, and NOTIFY payloads, which carry ids only (story 4.3). Tokens in story 6.4's GET links are recorded for 6.4 in `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| Postgres error, top level | `PostgresError` with a secret in each value field, logged as `err` and as `error` | no secret anywhere; `code`, `constraint_name` and a stack present |
| `pg` error | `DatabaseError` (name `error`) with `detail`, `internalQuery` and a multi-line message | all redacted, stack included |
| Other key | `log.error({ reason: pgErr }, 'x')` | scrubbed as under `err` |
| Bare error | `log.error(pgErr)`; `log.error({ err: pgErr })` | `msg` is `Database error <code>` |
| Wrapped | an `Error` with `{ cause: pgErr }`; a property `inner: pgErr`; `AggregateError([pgErr])` | each nested error scrubbed, with its own `code` |
| ExceptionBase | `DatabaseErrorException` with a database `cause`, logged and via `toJSON()` | no secret; `cause` still a string in `toJSON` |
| Debug-level enumerable `parameters`, `args` | at any depth | redacted |
| Plain error | `new Error('the database went away')` | message and stack unchanged |
| 5xx through `logFailure` | database error | `msg` is `Database error <code>` |
| Fastify request refusal | malformed JSON body holding an address; `GET /status/%E0` | info line's `msg` is the refusal's `code`; response unchanged |
| Overridden logger | `buildApp({ logger: { level, stream } })` (worker, seed) | same scrub |

</frozen-after-approval>

## Code Map

- `src/shared/db/sql-debug.ts` -- `LOG_REDACT_PATHS` (:9), `appLoggerOptions` (:64-84). Add the scrub here.
- `node_modules/postgres/src/connection.js:31-50` -- `errorFields`, enumerable through `Object.assign` except `message`, which keeps `Error`'s non-enumerable attribute but is emitted by any serializer. `queryError` (:396-409) adds `parameters`, `args`, `query` and `types`, enumerable only when `debug` is on.
- `pino-std-serializers@7.1.0` `lib/err.js` -- folds causes with `messageWithCauses` and `stackWithCauses`, skips the `cause` key, recurses into `errors`. Replace it; do not wrap it.
- `node_modules/fastify/lib/logger-factory.js:119` -- `Object.assign({}, defaults, options.serializers)`, so ours win.
- `pino@10.3.0` `lib/proto.js:216-224` -- a bare `Error` becomes `{ err }` and its message the `msg`, and `{ err }` with no message takes `err.message`. A `hooks.logMethod` sees the arguments first. Child loggers inherit hooks and serializers.
- `node_modules/.pnpm/pg-protocol@*/.../dist/messages.js:36-41` -- `DatabaseError`'s `name` is the protocol message name, `error`.
- `src/api.ts:14,31,54` and `src/worker.ts:469` log bare errors; `src/api.ts:47` passes `error.message` as a format argument. The hook covers them; leave the call sites.
- `src/server/build-app.ts:52-54` -- the logger is `appLoggerOptions(overrides.logger, level)`. The worker (`src/worker.ts:461`) and seed (`db/seeds/seed.ts:147`) pass `{ logger: { level } }` and get it too. `src/worker.ts` needs no change. The proof is the overridden-logger test.
- `src/shared/db/postgres.ts:7-9` -- the SQL-debug `pino({ level, redact })`. Give it the same options.
- `src/server/error-logging.ts:24,27-28` -- `logFailure`: `msg` is `error.message` on both branches. `isRequestRefusal` in `src/server/plugins/error-handler.ts:85` stays private; the rule goes in `logFailure`.
- `src/shared/exceptions/exception-base.ts:52` -- `cause: JSON.stringify(this.cause)`.
- `src/shared/cqrs/event-bus.ts:18-20` -- `reportToConsole`. The default is used only by buses built without `onHandlerError` (specs). The app's bus logs through `fastify.log` (`src/shared/cqrs/index.ts:17-22`).
- `db/seeds/seed.ts:271,284` -- `console.error(error)` and `console.error(result.reason)`. The `console.log` lines are for people and stay.
- `src/server/error-logging.integration.test.ts` -- `logsOf` and the `logLines` stream (:74). `repository` patching for a 500 (around :180-196). The story 9.13 case is at :199. `:163` asserts the malformed body's `msg` is `rest.message`, and must change to the code. `watchdog_app` has `TEMP` on the database (checked).
- `src/shared/db/sql-debug.spec.ts` -- story 9.13's unit cases. Extend it.
- `src/shared/testing/` has no log-capture helper.

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/db/sql-debug.ts`:
  - add `serializeError` and `isDatabaseError`;
  - add `LOG_SERIALIZERS` (`err` and `error`), a `logMethod` hook, and `scrubbedLoggerOptions(level)`, which returns `{ level, redact, serializers, hooks }`;
  - add `logMessageOf(error)`: `Database error <code>` for a database error, otherwise the message;
  - `appLoggerOptions` merges `LOG_SERIALIZERS` over the caller's serializers and sets the hook, chaining a caller's own `logMethod` if one is given.
- [x] `src/shared/db/postgres.ts` -- use `scrubbedLoggerOptions`.
- [x] `src/server/error-logging.ts` -- the 5xx `msg` comes from `logMessageOf`. A 4xx whose `code` starts `FST_ERR_` logs that code as `msg`.
- [x] `src/shared/exceptions/exception-base.ts` -- `cause` becomes `JSON.stringify(serializeError(this.cause))`, still `undefined` when there is none.
- [x] `src/shared/cqrs/event-bus.ts` -- replace `reportToConsole` with `reportToLogger(logger)`. The default uses a lazily built `pino(scrubbedLoggerOptions('error'))`.
- [x] `db/seeds/seed.ts` -- the two `console.error` calls log `{ err }` through `pino(scrubbedLoggerOptions('info'))`.
- [x] `src/shared/testing/logs.ts` (new) -- `captureLogs()` returns `{ stream, lines, entries() }`. Move `error-logging.integration.test.ts`'s `logLines` stream and the 9.13 case's own stream onto it.
- [x] `src/shared/db/sql-debug.spec.ts` -- the matrix rows, through a real pino with `scrubbedLoggerOptions` and the stream from `captureLogs`.
- [x] `src/shared/cqrs/event-bus.spec.ts`:
  - `reportToLogger` scrubs a database error;
  - the default reporter never calls `console.error`. No existing `eventBus()` default case fails a handler, so the unit run stays quiet.
- [x] `src/server/error-logging.integration.test.ts`:
  - a patched handler causes a real unique violation, on a `temp` table `on commit drop`, with a distinctive address. Its 500 line holds no address and keeps `23505`, `constraint_name` and a stack;
  - also `select $1::int` with the address, which puts it in `message`;
  - the story 9.13 case also logs real wrapped and aggregate database errors through both the app's logger and an overridden logger;
  - `:163` expects `FST_ERR_CTP_INVALID_JSON_BODY`, and the malformed-URL case checks its `msg` is `FST_ERR_BAD_URL`.
- [x] `docs/bmad/implementation-artifacts/deferred-work.md` -- mark both "Epic 6 prerequisite" entries resolved by story 6.1. Add one entry targeted at story 6.4: Fastify's request log records each URL, so a confirm or unsubscribe token in a GET link's path or query is logged.

**Acceptance Criteria:**
- Given each redaction and recursion step, when it is reverted, then a named test fails. Implementation Notes record each one.
- Given the whole change, when the definition of done runs, then every command under Verification passes.

## Implementation Notes

- `serializeError` recurses through errors, arrays and plain objects; other class instances pass through as they are. A repeat on the current path prints `[Circular]`; a value below depth 8 prints `[Truncated]`. Error-like is `instanceof Error` or `isDatabaseError`, so a plain object with a `message` (an incident update) is walked as a plain object and keeps its shape.
- The `logMethod` hook serializes every top-level array, plain object or error outside `err` and `error`, so an error nested in one is scrubbed. A string `msg` that is exactly a top-level database error's message becomes `Database error <code>`; one that quotes it has each occurrence replaced with `[Redacted]`. `{ error }` with no message keeps pino's behaviour (no `msg`).
- A database error's stack header, everything before the first frame line, becomes `<name>: [Redacted]`, so a message changed after the stack was rendered still never prints. V8 renders the stack on first read, and postgres.js reads it in `queryError`. Without a frame line, the current message is replaced.
- `logFailure` applies `logMessageOf` to a 4xx that is not a Fastify refusal as well; for anything but a database error that is its message, unchanged.
- The event bus's default reporter writes to `process.stderr`, so its spec can capture the line synchronously and the unit run stays quiet.
- The seed's logger writes to stderr, as `console.error` did. Its production refusal (a fixed string, not an error) also goes through it, so the seed has no `console.error` left.
- `src/server/graphql-error-formatter.integration.test.ts` asserted the masked database error's logged message was Postgres's text. It now asserts `msg` `Database error 22P02`, `err.code` `22P02` and `err.message` `[Redacted]`.
- `src/server/error-logging.spec.ts` (new) checks `logFailure`'s own arguments with a recording logger. Through pino, the hook's message guard hid a revert of the 5xx `logMessageOf`.

Reverted one at a time; the named test fails (unit specs, plus `error-logging.integration.test.ts` where noted):

| Reverted | Failing test |
|---|---|
| database `message` redaction | `scrubs a postgres.js error logged as err` / `as error`, `scrubs a pg error, ...` |
| message inside the stack | the same three |
| `detail`, `where`, `hint`, `internal_query` (each) | `scrubs a postgres.js error logged as err` / `as error` |
| `internalQuery` | `scrubs a pg error, its multi-line message included in the stack` |
| `parameters`, `args` (each) | `redacts parameters and args on any error, at any depth` |
| `cause` recursion | `scrubs a database error as a cause` |
| `AggregateError` recursion | `scrubs an AggregateError's members` |
| property recursion | `scrubs a database error held by a property` |
| array / plain-object recursion (each) | `scrubs a database error held by a property` |
| cycle guard; depth limit (each) | `survives a cycle and stops at depth 8` |
| `isDatabaseError`'s SQLSTATE rule | `knows a postgres.js and a pg error, and nothing else` |
| hook: bare error | `never makes a database error the message of a bare error`; integration `keeps parameters and args off a logged error, ...` |
| hook: `{ err }` with no message | `never makes a database error the message of a bare error` |
| hook: other key | `scrubs a database error under any other key` |
| hook: message guard | `never makes a database error the message of a bare error` |
| `appLoggerOptions` serializers | `keeps a caller's serializers but always scrubs err and error`; integration 500-line tests |
| `appLoggerOptions` hook; chaining a caller's hook (each) | `runs a caller's logMethod hook first, then the scrub` |
| `scrubbedLoggerOptions` serializers | `scrubs a postgres.js error logged as err` and the event bus's two story 6.1 cases |
| `ExceptionBase.toJSON` | `scrubs an ExceptionBase, logged and through toJSON` |
| event bus default reporter back to `console.error` | `never calls console.error by default, and scrubs what it writes` |
| `logFailure` 5xx `logMessageOf` | `names a 5xx database error by its code, never by its message` |
| `isErrorLike` as `instanceof Error` | `keeps the shape of a domain object that has a message` |
| hook: top-level arrays and plain objects | `scrubs a database error nested in any top-level array or object` |
| hook: quoted message replaced | `redacts a database error quoted inside a message` |
| stack header replaced to the first frame | `redacts the stack header of a database error whose message changed` |
| stack fallback without frames | `falls back to replacing the message in a stack with no frames` |
| `logFailure` `FST_ERR_` code | `logs Fastify's own refusal of a request by its code`; integration malformed-body and malformed-URL cases |

## Spec Change Log

## Review Triage Log

Pass 1 (2026-10-21): blind hunter (B), edge-case hunter (E), verification gap (V).

| # | Finding | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | V: the seed's failure logging has no executed test | medium | No suite runs `db/seeds/seed.ts`; a revert to `console.error` passes every suite. A test needs a subprocess or a refactor | defer |
| 2 | V, B9, E9: seed failures moved from stderr to stdout | medium | `pino()` with no destination writes to fd 1; `console.error` wrote to fd 2 | patch |
| 3 | B1: AGENTS.md's pitfall on redaction now contradicts the code | medium | The "Log a database error only as a top-level `err`..." pitfall says `message`, `detail`, nested and `console.error` still print. Agent-context file; owner must approve | patch (owner approved) |
| 4 | B2: Better Auth's logger prints errors with `console.error` | low | Real (`@better-auth/core/dist/env/logger.mjs:64`), but excluded by the frozen Never. The deferred-work note overclaimed "nothing prints" | patch (note wording) |
| 5 | B3: postgres.js notices go to `console.log` unscrubbed | low | `connection.js:916-918`, neither client sets `onnotice`. Pre-existing; no migration raises a notice | defer |
| 6 | B4, E1: GraphQL coercion errors quote variable values in an info line | false | Excluded by the frozen Never: subscribe, confirm and unsubscribe are REST only (ARCHITECTURE 7.1), so no address is a GraphQL argument | reject |
| 7 | B5: an `ExceptionBase` message could interpolate caller input | low | No such message exists; a rule for the subscriber slices | defer (story 6.3) |
| 8 | B6, E2, E3, E10: the message guard catches only an exact match | low | a message built as `failed: ${err.message}` would leak; no call site does it today. Substring replacement is a direct correction | patch |
| 9 | B7, E4: a database error nested in an array or object under another key is not scrubbed | low | `scrubLogArguments` checks only top-level error-like values | patch |
| 10 | B8: `isErrorLike` reshapes any plain object with a string `message` | low | An incident update logged as `{ update }` would come back as `type: 'Object'` | patch |
| 11 | B10: the scrub lives in `sql-debug.ts` | false | The frozen Always places it there deliberately; the fix edits the spec | reject |
| 12 | B11, E6: the stack's message is removed by string replacement | low | A message changed after capture leaves the original in the header. Replacing the header is a direct correction | patch |
| 13 | E5: a database error held by a class instance is not walked | low | No call site logs one; walking class instances adds branches | reject |
| 14 | E7: child-logger bindings under a non-err key skip the hook | low | Nothing binds an error to a child; `err` bindings still pass the serializer | reject |
| 15 | E8: `ExceptionBase.toJSON` writes `metadata` unscrubbed | low | `toJSON` has no callers; logged exceptions walk `metadata` through the serializer. Pre-existing | reject |

## Verification

**Commands:**
- `pnpm run check` -- passes
- `pnpm run test` -- passes, and again with `.env` moved to the scratchpad
- `pnpm run test:integration` -- passes with only `postgres`, `mailpit` and `migrate` up (bare `docker compose up -d`)
- `pnpm run test:e2e` -- 10 scenarios pass
- `pnpm run auth:schema:check` -- passes

**Manual checks:**
- `db/seeds/seed.ts` has no `console.error` left; its failures go through `scrubbedLoggerOptions`.
