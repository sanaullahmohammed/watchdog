# Deferred work

## From Story 9.1 (2026-10-06)

- source_spec: spec-9-1-graphql-service-validation.md
  summary: `description` has no `maxLength` in the create or update request schemas, so an arbitrarily long description is stored on both surfaces.
  evidence: Review Triage Log #18; both schemas declare `description` as a bare `Type.String`. Fixing it edits the TypeBox schemas, which Story 9.1 may not.
- source_spec: spec-9-1-graphql-service-validation.md
  summary: `displayOrder` at or above 2^31 overflows the integer column and answers a masked 500 over REST only (GraphQL's signed 32-bit `Int` refuses it itself); the schemas set a minimum but no maximum.
  evidence: Review Triage Log #19; probe showed both validators accept 2147483648 and the column is `integer`.
- source_spec: spec-9-1-graphql-service-validation.md
  summary: `urn:uuid:<uuid>` passes the uuid format of both TypeBox and ajv, so REST and GraphQL let it reach Postgres. Decide whether `assertUuid` and the route schemas should require the plain form.
  evidence: Review Triage Log #20; no test asserts it either way.
- source_spec: spec-9-1-graphql-service-validation.md
  summary: Whitespace-only names are stored on both surfaces. Whether to refuse them is a product rule.
  evidence: Review Triage Log #21; pre-existing on REST and GraphQL.
- source_spec: spec-9-1-graphql-service-validation.md
  summary: REST coerces null to `0`, `false` or `""` before the handler (Fastify's ajv `coerceTypes`), so REST accepts nulls that GraphQL now refuses. Settle which is intended.
  evidence: Review Triage Log #22; `displayOrder: null` over REST gives 0.
- source_spec: spec-9-1-graphql-service-validation.md
  summary: The AGENTS.md convention says older handlers using `src/shared/validation/input.ts` "move to this as they are touched", but only `assertNoNullFields` is replaced by a schema check; `parseDate`, `parseOptionalDate`, `assertNoDuplicates` and `assertNotBlank` have no schema equivalent and stay. Reword the bullet to name `assertNoNullFields`.
  evidence: Review Triage Log #33; routed defer because the fix edits an agent-context file.
- source_spec: spec-9-2-anonymous-graphql-rate-limit.md
  summary: Authenticated callers are never rationed, and sign-up is open, so anyone can mint a session that exempts them from the GraphQL limit. Decide on an authenticated limit before production exposure.
  evidence: `isRationedGraphqlRequest` exempts any valid session; Better Auth sign-up needs no invitation.
- source_spec: spec-9-2-anonymous-graphql-rate-limit.md
  summary: The anonymous GraphQL limiter looks up the session before checking the bucket, so a caller replaying a validly signed but signed-out session token costs one session query per request even after its bucket is spent. Unsigned or forged cookies cost nothing, because Better Auth refuses them before querying.
  evidence: Story 9.2 Review Triage Log #4; `node_modules/better-auth/dist/api/routes/session.mjs` returns null on a failed signed-cookie check before any query. Revisit with the authenticated-limit entry above.
- source_spec: spec-9-2-anonymous-graphql-rate-limit.md
  summary: The AGENTS.md "anonymous surface is bounded" bullet now carries a `/graphql`-specific parenthetical inside a list of bounds every new public route inherits. Move it into its own sentence after the list, so it does not read as a rule for every route.
  evidence: Story 9.2 Review Triage Log #15; routed defer because the fix edits an agent-context file.

## From Story 9.3 (2026-10-07)

- source_spec: spec-9-3-graphql-incident-validation.md
  summary: `startedAt: "0000-01-01T00:00:00Z"` passes ajv's `date-time` on both surfaces and Postgres rejects it with "date/time field value out of range", a masked 500. Decide a sane range for incident start times.
  evidence: Spec review probe; ajv-formats accepts year 0000 and `new Date` parses it. Pre-existing on REST and GraphQL; fixing it edits the TypeBox schema, which Story 9.3 may not.
- source_spec: `spec-9-3-graphql-incident-validation.md`
  summary: A whitespace-only `message` is stored on create and transition over both surfaces, because those schemas have `minLength: 1` without post-update's `pattern: '\S'`.
  evidence: Story 9.3 Review Triage Log #14; fixing it edits the TypeBox schemas, which Story 9.3 may not.
- source_spec: `spec-9-3-graphql-incident-validation.md`
  summary: `affectedServices` has no `maxItems`, so a very long list is validated in full before refusal; the message is capped at ten fields but the work is not.
  evidence: Story 9.3 Review Triage Log #15; bounded by the body limit, pre-existing on both surfaces.
- source_spec: `spec-9-3-graphql-incident-validation.md`
  summary: A `startedAt` whose offset moves it outside years 1..9999, such as `9999-12-31T23:59:59-23:59`, passes the format and becomes a masked 500 when Postgres rejects it. Settle with the year-0000 entry above.
  evidence: Story 9.3 Review Triage Log #16; `new Date(...).toISOString()` gives `+010000-01-01T23:58:59.000Z`.
- source_spec: `spec-9-3-graphql-incident-validation.md`
  summary: Timeline order (`created_at` from `clock_timestamp()`, then `id`) assumes the database clock never steps back. On the owner's Docker Desktop on WSL2 it steps back by up to 1.4 s several times a minute, so incident timeline tests fail intermittently (about 1 full run in 10) with a later entry sorted before the declaration. Decide whether to record it as an AGENTS.md pitfall, make the tests tolerate it, or order entries by something monotonic.
  evidence: Story 9.3 verification. A tight `clock_timestamp()` loop in the postgres container saw 4 backward steps in 120 s, worst 1.411 s, and `journalctl` logs "Time jumped backwards" every ~27 s. Failures seen: `incident-concurrency` "makes a posted update wait…" and "never reopens a resolved incident…", `incident-lifecycle` "appends a timeline entry with each transition…". All three show a later status sorted before `investigating`; no timeline write or ordering code changed in this story.

## From Story 9.4 (2026-10-07)

- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: Over REST, `description: null` on maintenance schedule and update is stored as `""`, not NULL, because Fastify's `coerceTypes` turns null into `""` in the union's string branch; GraphQL stores NULL. Settle with the 9.1 entry on REST null coercion.
  evidence: Spec review probe: real Fastify with `updateMaintenanceRequestDtoSchema`, `PATCH {"description":null}` answered 200 with `{"description":""}`. Pre-existing; the fix touches REST coercion, outside this story.

- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: Story 9.4 deleted `parseOptionalDate` and `assertNoNullFields` from `src/shared/validation/input.ts`, since the slice schemas now decide nulls and formats. The 9.1 AGENTS.md entry about those helpers now concerns only `parseDate` and `assertNoDuplicates`.
  evidence: No production caller of either remained after the maintenance handlers moved to `assertMatchesSchema`; their `input.spec.ts` cases went with them.
- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: The AGENTS.md bullet "Older handlers that still use `src/shared/validation/input.ts` move to this as they are touched" is now stale: no handler uses `assertNoNullFields`, which is deleted. Reword it to say `input.ts` keeps `parseDate` and `assertNoDuplicates`, which a schema cannot express.
  evidence: Story 9.4 Review Triage Log #4; routed defer because the fix edits an agent-context file.
- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: Maintenance `scheduledStartAt`/`scheduledEndAt` outside years 1..9999 (year 0000, or an offset across the boundary) pass the format and become a masked 500 when Postgres rejects them. Settle with the incident `startedAt` entries above.
  evidence: Story 9.4 Review Triage Log #14; pre-existing on both surfaces.
- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: The same service UUID written in two letter cases passes `assertNoDuplicates` (an exact string compare) and hits the `maintenance_services` primary key, an unmapped 23505 that answers a masked 500. Incident `affectedServices` is likely the same; compare ids case-insensitively or map 23505.
  evidence: Story 9.4 Review Triage Log #15; `maintenance.repository.ts` maps only 23503. Pre-existing on both surfaces.
- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: `urn:uuid:<uuid>` passes `assertUuid` on the 9.4 maintenance mutation id checks too, and, since retro item 1b, on the `maintenanceWindow(id)` read, so it still reaches Postgres as a masked 500. Settle with the 9.1 `urn:uuid:` entry.
  evidence: Story 9.4 Review Triage Log #16.

## From Story 9.5 (2026-10-07)

- source_spec: `spec-9-5-organization-slug-rule.md`
  summary: Better Auth's `POST /api/auth/organization/check-slug` still answers "available" for an untaken slug outside the rule, which create then refuses with `INVALID_ORGANIZATION_SLUG`. Apply the rule there too (a `hooks.before` on that path) or disable the endpoint, before any client relies on it.
  evidence: Story 9.5 Review Triage Log #3; `crud-org.mjs:151-159` checks only existence. No WatchDog code calls it today.

## From Story 9.6 (2026-10-07)

- source_spec: `spec-9-6-read-service-groups.md`
  summary: `GET /api/v1/service-groups/urn:uuid:<uuid>` and `serviceGroup(id: "urn:uuid:<uuid>")` pass the uuid checks and reach Postgres as a masked 500. Settle with the 9.1 `urn:uuid:` entry.
  evidence: Story 9.6 Review Triage Log #6; `ajv-formats` uuid regex allows the `urn:uuid:` prefix and Postgres's uuid input refuses it.
- source_spec: `spec-9-6-read-service-groups.md`
  summary: The admin GraphQL `Service` type exposes `serviceGroupId` but no `group: ServiceGroup` field, so a client joins services to groups itself. Decide whether to add the field.
  evidence: Story 9.6 Review Triage Log #7; changing `Service` was outside Story 9.6.
- source_spec: `spec-9-6-read-service-groups.md`
  summary: REST route schemas declare only their success response, so the generated API description shows no 400, 401 or 404. Settle with API documentation (audit F-10, Epic 8).
  evidence: Story 9.6 Review Triage Log #8; pre-existing across every route.

## From Story 9.7 (2026-10-07)

- source_spec: `spec-9-7-read-one-incident.md`
  summary: Two clients editing one incident from separate reads still silently drop each other's affected services, because `PATCH`/`updateIncident` replaces the whole list with no precondition and the detail read carries no `updatedAt` or version. Decide on optimistic concurrency (a version or `updatedAt` precondition) before more than one operator edits at once.
  evidence: Story 9.7 Review Triage Log #6; `update-incident.handler.ts` replaces the list unconditionally. Pre-existing in the edit; the new read makes the single-client round trip safe, not the two-client one.

## From Story 9.9 (2026-10-07)

- source_spec: `spec-9-9-close-auth-pool.md`
  summary: ARCHITECTURE section 7 says "no entrypoint or script forces exit", but graceful-server ends the api with its own `process.exit`; and neither ARCHITECTURE nor AGENTS.md records that Better Auth's pool is process-wide and ends at the last `app.close()`, after which `buildApp()` in that process throws. Update ARCHITECTURE first, then add an AGENTS.md pitfall for test authors (build apps while one is open, or one per process).
  evidence: Story 9.9 Review Triage Log #6; `docs/genesis/ARCHITECTURE.md:782`; `holdAuthPool()` in `src/server/auth/auth.ts`. Routed defer because the fix edits genesis and agent-context files.
- source_spec: `spec-9-9-close-auth-pool.md`
  summary: No test proves the api's shutdown finishes `fastify.close()` (drain, auth pool) before `closeDbConnection()`; removing `syncClose: true` would pass every suite.
  evidence: Story 9.9 Review Triage Log #7. A meaningful test spawns the api, starts a slow event handler, sends SIGTERM and checks the handler's database work completed.

## From Story 9.10 (2026-10-07)

- source_spec: `spec-9-10-worker-health.md`
  summary: `startWorker`'s health wiring (record path, loop names, heartbeat timer) is checked only by hand; no test starts the real worker and runs its healthcheck. Add a seam (an injected pass or `orgIds`) so a test can start it without an unscoped pass.
  evidence: Story 9.10 Review Triage Log #11; AGENTS.md forbids unscoped worker passes in integration tests.

## From Story 9.12 (2026-10-08)

- source_spec: `spec-9-12-public-cors.md`
  summary: A request the router answers itself never reaches the public route, so its 404 carries no CORS headers. Examples are `/status/x/` (trailing slash) and `/status/a/b`. A browser script on another origin sees an opaque network error for these.
  evidence: Story 9.12 Boundaries (out of scope); route-level `onSend` runs only for requests the router matched. A fix would be a not-found handler scoped to `/status/`.
- source_spec: `spec-9-12-public-cors.md`
  summary: `HEAD /status/:orgSlug` with a matching `If-None-Match` answers 500 instead of 304. The route's `onSend` returns `null` for a 304, and Fastify's automatic HEAD route then runs its own `onSend` on that `null` and throws.
  evidence: Story 9.12 Review Triage Log #1; reproduced (GET 200 with an ETag, then HEAD with that tag gave 500). Predates Story 9.12. Fix by returning `undefined` for a HEAD 304, or by declaring the HEAD route explicitly, with a test.
- source_spec: `spec-9-12-public-cors.md`
  summary: A malformed percent-encoding such as `/status/%E0` is answered by the router as a 400 with no CORS headers. A not-found handler would not cover it; it needs Fastify's `frameworkErrors`.
  evidence: Story 9.12 Review Triage Log #2; reproduced, 400 with no `access-control-allow-origin`. Settle with the router-404 entry above.
- source_spec: `spec-9-12-public-cors.md`
  summary: A cross-origin script can read the public page's 429 but not its `Retry-After`, because only `ETag` is exposed. Exposing `Retry-After` changes ARCHITECTURE 5.4.1 first; the same edit could say the headers go on every answer.
  evidence: Story 9.12 Review Triage Log #3 and #4.

## From Story 9.13 (2026-10-08)

- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Values inside a Postgres error message or `detail`, such as `invalid input syntax for type integer: "..."` or a unique-key violation's `Key (email)=(...)`, still reach the logs. Story 9.13 redacts only the `parameters` and `args` properties. Epic 6 prerequisite: redact or replace `message` and `detail` of database errors before subscriber addresses are stored.
  evidence: Story 9.13 Boundaries (Never); `err.message` and `err.detail` are logged by `logFailure` and the worker.
- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Log redaction covers only top-level `err.parameters`, `err.args`, `error.parameters` and `error.args`. In debug mode, a database error wrapped in another error, inside an `AggregateError`, serialized through `ExceptionBase.toJSON` (which stringifies its `cause`), logged under another key, or printed with `console.error` (seed failures, the event bus's default reporter) still prints parameter values. Consider a recursive scrub in the `err`/`error` serializers before Epic 6.
  evidence: Story 9.13 Review Triage Log #4 and #5. Unverified in practice: `DatabaseErrorException` exists but nothing constructs it today.
- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Record the logging rule in AGENTS.md: log database errors only as a top-level `err` or `error` through a pino logger, and give `postgres()` a `debug` option only through `sqlDebugOption`.
  evidence: Story 9.13 Review Triage Log #6; routed defer because the fix edits an agent-context file.
- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Besides `message` and `detail`, Postgres errors carry `where`, `hint` and `internal_query`, which can echo values. The Epic 6 prerequisite on values in Postgres errors should cover every field postgres.js copies onto the error.
  evidence: Story 9.13 Review Triage Log #7.

## From Story 9.14 (2026-10-08)

- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: DOMAIN's "v1 has no hard service delete" could note that a migration enforces it, as its `check_results` entry does. Changes DOMAIN first.
  evidence: Story 9.14 Tasks.
- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: Because the runtime role can insert and delete rows in dbmate's `schema_migrations`, a migration can be recorded as applied when it never ran (or hidden), so a revoke like this story's could appear applied while absent; a bare `dbmate up` or `down` as that role does exactly this. The fix is a migration revoking `watchdog_app`'s privileges on `schema_migrations`.
  evidence: Story 9.14 Code Map.
- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: AGENTS.md says "Services are archived, never hard-deleted." as a convention. Note beside it that a migration revokes `DELETE` on `services` from `watchdog_app`, and that `service-delete-privilege.integration.test.ts` guards the grant, as the append-only bullet does for `incident_updates`.
  evidence: Story 9.14 Review Triage Log #8; routed defer because the fix edits an agent-context file.

## From Epic 9 retro item 1a (2026-10-08)

- source_spec: `spec-epic-9-retro-1a-service-read-ids.md`
  summary: The REST-versus-GraphQL row comparison covers service create only; service update and service-group create and update are not compared, though REST's null coercion can store different values there.
  evidence: Review Triage Log #8; `service-input-validation.integration.test.ts` "stores the same columns over REST and GraphQL" creates only.
- source_spec: `spec-epic-9-retro-1a-service-read-ids.md`
  summary: `service(id)`, `incident(id)` and `incidentTimeline(id)` pass `assertUuid` with a `urn:uuid:<uuid>` id and still answer a masked 500 (the incident reads over REST too), as the other `urn:uuid:` entries describe for mutations, maintenance and groups.
  evidence: Review Triage Log #13; `typebox-guard.ts:78` checks `format: 'uuid'` only, which ajv-formats lets carry the `urn:uuid:` prefix; the retro 1c review reproduced it for `incident(id)` and `incidentTimeline(id)` over both surfaces.
- source_spec: `spec-epic-9-retro-1c-incident-timeline-read-ids.md`
  summary: Nothing fails when a new id-taking GraphQL `Query` field ships without a malformed-id case, so its handler can skip `assertUuid` and answer a masked 500 again. The retro's DR-1 Prevention proposes 9.11's registry pattern applied to `Query` fields.
  evidence: Review Triage Log #2; every id-taking read has a hand-written malformed-id test today, but no test enumerates `Query` fields the way 9.11's registry enumerates mutations.

## From Epic 9 retro item 2 (2026-10-08)

- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: No test runs the real worker's `shutdown`, so the DR-4 fix could be unwired (`shutdown` calling `app.close()` and `closeDbConnection()` directly again) and nothing would fail; `closeWorker` is tested only as a helper. Close it together with the 9.10 entry above, which needs the same seam to start the real worker.
  evidence: Review Triage Log #5; `closeWorker` is referenced only by `src/worker-health.integration.test.ts`, and the only test that starts the worker (`runtime-role.integration.test.ts:122-133`) exits before `shutdown` is registered.
- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: The api lists `closeDbConnection` unguarded in graceful-server's `closePromises` with `syncClose: true`, so a rejection there skips the remaining steps and the exit, the gap the worker's `closeWorker` now closes.
  evidence: Review Triage Log #12; `src/api.ts:34`, and the comment above it at `:19-23` describes the skip. Pre-existing.
- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: `src/worker-health.ts:149` logs a failed heartbeat write as `{ error }`, which pino prints as `{}`, so the reason is lost. Use `{ err: error }`, as `src/worker.ts` now does.
  evidence: Review Triage Log #6; `fastify({ logger: true }).log.error({ error: new Error('boom') }, 'x')` prints `"error":{}`. Pre-existing, and the spec ruled `worker-health.ts` out of this change.

## From Epic 9 retro item 4 (2026-10-09)

- source_spec: `spec-epic-9-retro-4-shared-test-helpers.md`
  summary: Maintenance suites still define their own window fixture, which duplicates the shared `scheduleMaintenance`: `schedule` in `end-maintenance` and `read-maintenance`, and `createWindow` in `maintenance-input-validation`. Item 4 named only `createService`, `createGroup`, `declare`, `capturing` and `gql`, so these stayed. (`schedule-maintenance`'s and `maintenance-input-validation`'s `schedule` return the raw response for the test to assert on, so those are not fixtures.)
  evidence: Review Triage Log #3; `grep -rnE "(function|const) (schedule|createWindow)\b" src --include='*.test.ts'`.
- source_spec: `spec-epic-9-retro-4-shared-test-helpers.md`
  summary: 23 test files still declare `const ORIGIN = 'http://localhost:3000'`, a copy of `TEST_ORIGIN` from `src/shared/testing/tenant.ts`. Migrated files now send both: the fixtures send `TEST_ORIGIN`, the file's own requests send `ORIGIN`.
  evidence: Review Triage Log #4; `grep -rln "const ORIGIN = 'http://localhost:3000'" src`.
