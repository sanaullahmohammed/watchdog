# Deferred work

Conventions, set by Epic 9 retro action item 8 (2026-10-09):
- **`target:`** Every entry ends with a `target:` line. It names the one epic or trigger that should pick the entry up. The delivery order of epics is owned by ROADMAP section 2 (see `epics.md` Epic List).
- **"Epic 8 (default)"** means no source names an earlier point. Epic 8 is release readiness.
- **"AGENTS.md edit"** is housekeeping for the dev loop, done with the next change to AGENTS.md.
- **"Genesis edit (owner)"** changes a document in `docs/genesis/` first, as the project policy requires. An edit that belongs to a code change goes with that change.
- **Several source specs on one entry** means it merges duplicates of one defect.

## From Story 9.1 (2026-10-06)

- source_spec: `spec-9-1-graphql-service-validation.md`
  summary: `description` has no `maxLength` in the create or update request schemas, so an arbitrarily long description is stored on both surfaces.
  evidence: Review Triage Log #18; both schemas declare `description` as a bare `Type.String`. Fixing it edits the TypeBox schemas, which Story 9.1 may not.
  target: Epic 8 (default).
- source_spec: `spec-9-1-graphql-service-validation.md`
  summary: `displayOrder` at or above 2^31 overflows the integer column and answers a masked 500 over REST only (GraphQL's signed 32-bit `Int` refuses it itself); the schemas set a minimum but no maximum.
  evidence: Review Triage Log #19; probe showed both validators accept 2147483648 and the column is `integer`.
  target: Epic 8 (default).
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-4-graphql-maintenance-validation.md`, `spec-9-6-read-service-groups.md`, `spec-epic-9-retro-1a-service-read-ids.md`
  summary: `urn:uuid:<uuid>` passes the uuid format of both TypeBox and ajv, so it reaches Postgres, which refuses it, and the caller gets a masked 500. Every `format: 'uuid'` check is affected. That covers the REST route params, the GraphQL mutation and read ids (`service(id)`, `incident(id)` over REST too, `incidentTimeline(id)`, `maintenanceWindow(id)`, `serviceGroup(id)` and `GET /api/v1/service-groups/:id`), and ids inside request bodies: `affectedServices[].serviceId` on incident create and update, `serviceGroupId` on service create and update, and the service ids of maintenance schedule and update. Decide whether `assertUuid` and the schemas should require the plain form. Settle it with the 9.4 letter-case duplicate-id entry, because normalizing ids could fix both.
  evidence: Story 9.1 Review Triage Log #20, Story 9.4 #16, Story 9.6 #6, and retro 1a #13. `typebox-guard.ts:78` checks `format: 'uuid'` only, and the `ajv-formats` uuid regex allows the `urn:uuid:` prefix. The retro 1c review reproduced it for `incident(id)` and `incidentTimeline(id)` over both surfaces.
  target: Epic 8 (default).
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-3-graphql-incident-validation.md`
  summary: Whitespace-only text is stored on both surfaces: service names, and an incident `message` on create and transition, whose schemas have `minLength: 1` without post-update's `pattern: '\S'`. Whether to refuse it is a product rule.
  evidence: Story 9.1 Review Triage Log #21 and Story 9.3 #14. Pre-existing on REST and GraphQL. Fixing it edits the TypeBox schemas.
  target: Epic 8 (default).
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-4-graphql-maintenance-validation.md`
  summary: REST coerces null to `0`, `false` or `""` before the handler (Fastify's ajv `coerceTypes`), so REST accepts nulls that GraphQL refuses, and stores different values where GraphQL stores NULL. Examples: `displayOrder: null` gives 0, and a maintenance `description: null` on schedule or update is stored as `""` through the union's string branch. Settle which is intended.
  evidence: Story 9.1 Review Triage Log #22, and the Story 9.4 spec review probe. Real Fastify with `updateMaintenanceRequestDtoSchema` answered `PATCH {"description":null}` with 200 and `{"description":""}`. Pre-existing. The retro 1a entry on REST-versus-GraphQL row comparison would catch a regression.
  target: Epic 8 (default).
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-4-graphql-maintenance-validation.md`
  summary: The AGENTS.md bullet "Older handlers that still use `src/shared/validation/input.ts` move to this as they are touched" is stale. `input.ts` now exports only `parseDate` and `assertNoDuplicates`, which no schema can express, so they stay. Reword the bullet to say so.
  evidence: Story 9.1 Review Triage Log #33 and Story 9.4 #4. Story 9.4 deleted `parseOptionalDate` and `assertNoNullFields`, and `assertNotBlank` is gone too (`grep -n "^export" src/shared/validation/input.ts`). Routed defer because the fix edits an agent-context file.
  target: AGENTS.md edit.
- source_spec: `spec-9-2-anonymous-graphql-rate-limit.md`
  summary: Authenticated callers are never rationed, and sign-up is open, so anyone can mint a session that exempts them from the GraphQL limit. Decide on an authenticated limit before production exposure.
  evidence: `isRationedGraphqlRequest` exempts any valid session; Better Auth sign-up needs no invitation.
  target: Before production exposure (Epic 8 at the latest).
- source_spec: `spec-9-2-anonymous-graphql-rate-limit.md`
  summary: The anonymous GraphQL limiter looks up the session before checking the bucket, so a caller replaying a validly signed but signed-out session token costs one session query per request even after its bucket is spent. Unsigned or forged cookies cost nothing, because Better Auth refuses them before querying.
  evidence: Story 9.2 Review Triage Log #4; `node_modules/better-auth/dist/api/routes/session.mjs` returns null on a failed signed-cookie check before any query. Revisit with the 9.2 authenticated-limit entry.
  target: Before production exposure (Epic 8 at the latest).
- source_spec: `spec-9-2-anonymous-graphql-rate-limit.md`
  summary: The AGENTS.md "anonymous surface is bounded" bullet now carries a `/graphql`-specific parenthetical inside a list of bounds every new public route inherits. Move it into its own sentence after the list, so it does not read as a rule for every route.
  evidence: Story 9.2 Review Triage Log #15; routed defer because the fix edits an agent-context file.
  target: AGENTS.md edit.

## From Story 9.3 (2026-10-07)

- source_spec: `spec-9-3-graphql-incident-validation.md`, `spec-9-4-graphql-maintenance-validation.md`
  summary: A date that passes ajv's `date-time` on both surfaces can still be refused by Postgres as a masked 500. This covers an incident's `startedAt` and a maintenance window's `scheduledStartAt` and `scheduledEndAt`, and there are two causes. Year 0000, such as `0000-01-01T00:00:00Z`, is refused with "date/time field value out of range". An offset that pushes the instant past year 9999, such as `9999-12-31T23:59:59-23:59`, becomes a `Date` that postgres.js sends as `+010000-01-01T23:58:59.000Z`, and Postgres refuses that with "time zone displacement out of range". Postgres itself stores far later years, so the fix is to bound the accepted years, or to change how dates are serialized.
  evidence: Story 9.3 spec review probe and Review Triage Log #16, and Story 9.4 #14. ajv-formats accepts year 0000, and `new Date` parses it. Both Postgres errors were reproduced with a `::timestamptz` cast on 2026-10-09. postgres.js serializes a `Date` with `toISOString()` (`node_modules/postgres/src/types.js:31`). Pre-existing on REST and GraphQL.
  target: Epic 8 (default).
- source_spec: `spec-9-3-graphql-incident-validation.md`
  summary: `affectedServices` has no `maxItems`, so a very long list is validated in full before refusal; the message is capped at ten fields but the work is not.
  evidence: Story 9.3 Review Triage Log #15; bounded by the body limit, pre-existing on both surfaces.
  target: Epic 8 (default).

## From Story 9.4 (2026-10-07)

- source_spec: `spec-9-4-graphql-maintenance-validation.md`
  summary: The same service UUID written in two letter cases passes `assertNoDuplicates` (an exact string compare) and hits the `maintenance_services` primary key, an unmapped 23505 that answers a masked 500. Incident `affectedServices` is likely the same; compare ids case-insensitively or map 23505. Settle it with the 9.1 `urn:uuid:` entry, since both are about canonical uuids.
  evidence: Story 9.4 Review Triage Log #15; `maintenance.repository.ts` maps only 23503. Pre-existing on both surfaces.
  target: Epic 8 (default).

## From Story 9.5 (2026-10-07)

- source_spec: `spec-9-5-organization-slug-rule.md`
  summary: Better Auth's `POST /api/auth/organization/check-slug` still answers "available" for an untaken slug outside the rule, which create then refuses with `INVALID_ORGANIZATION_SLUG`. Apply the rule there too (a `hooks.before` on that path) or disable the endpoint, before any client relies on it.
  evidence: Story 9.5 Review Triage Log #3; `crud-org.mjs:151-159` checks only existence. No WatchDog code calls it today.
  target: Before any client calls `check-slug`; Epic 8 (default) otherwise.

## From Story 9.6 (2026-10-07)

- source_spec: `spec-9-6-read-service-groups.md`
  summary: The admin GraphQL `Service` type exposes `serviceGroupId` but no `group: ServiceGroup` field, so a client joins services to groups itself. Decide whether to add the field.
  evidence: Story 9.6 Review Triage Log #7; changing `Service` was outside Story 9.6.
  target: When a client needs services with their groups; Epic 8 (default) otherwise.
- source_spec: `spec-9-6-read-service-groups.md`
  summary: REST route schemas declare only their success response, so the generated API description shows no 400, 401 or 404. Settle with API documentation (audit F-10, Epic 8).
  evidence: Story 9.6 Review Triage Log #8; pre-existing across every route.
  target: Epic 8 (API documentation, audit F-10).

## From Story 9.7 (2026-10-07)

- source_spec: `spec-9-7-read-one-incident.md`
  summary: Two clients editing one incident from separate reads still silently drop each other's affected services, because `PATCH`/`updateIncident` replaces the whole list with no precondition and the detail read carries no `updatedAt` or version. Decide on optimistic concurrency (a version or `updatedAt` precondition) before more than one operator edits at once.
  evidence: Story 9.7 Review Triage Log #6; `update-incident.handler.ts` replaces the list unconditionally. Pre-existing in the edit; the new read makes the single-client round trip safe, not the two-client one.
  target: Before two operators edit one incident at once.

## From Story 9.9 (2026-10-07)

- source_spec: `spec-9-9-close-auth-pool.md`
  summary: Add an AGENTS.md pitfall for test authors: build test apps while another is still open, or use one process per app (Better Auth's pool is process-wide and ends at the last `app.close()`, after which `buildApp()` in that process throws).
  evidence: Story 9.9 Review Triage Log #6; `holdAuthPool()` in `src/server/auth/auth.ts`. This commit fixed the ARCHITECTURE section 7 wording; only the AGENTS.md pitfall remains.
  target: AGENTS.md edit.
- source_spec: `spec-9-9-close-auth-pool.md`
  summary: No test proves the api's shutdown finishes `fastify.close()` (drain, auth pool) before `closeDbConnection()`; removing `syncClose: true` would pass every suite.
  evidence: Story 9.9 Review Triage Log #7. A meaningful test spawns the api, starts a slow event handler, sends SIGTERM and checks the handler's database work completed.
  target: Epic 8 (boot and container checks, audit F-11).

## From Story 9.10 (2026-10-07)

- source_spec: `spec-9-10-worker-health.md`
  summary: `startWorker`'s health wiring (record path, loop names, heartbeat timer) is checked only by hand; no test starts the real worker and runs its healthcheck. Add a seam (an injected pass or `orgIds`) so a test can start it without an unscoped pass.
  evidence: Story 9.10 Review Triage Log #11; AGENTS.md forbids unscoped worker passes in integration tests. Epic 5 adds the monitor-check loop to this worker. Close it together with the retro item 2 shutdown entry, which needs the same seam.
  target: Epic 5.

## From Story 9.12 (2026-10-08)

- source_spec: `spec-9-12-public-cors.md`
  summary: A request the router answers itself never reaches the public route, so its 404 carries no CORS headers. Examples are `/status/x/` (trailing slash) and `/status/a/b`. A browser script on another origin sees an opaque network error for these.
  evidence: Story 9.12 Boundaries (out of scope); route-level `onSend` runs only for requests the router matched. A fix would be a not-found handler scoped to `/status/`. Epic 4 adds `/status/:orgSlug/events` to the public surface.
  target: Epic 4.
- source_spec: `spec-9-12-public-cors.md`
  summary: `HEAD /status/:orgSlug` with a matching `If-None-Match` answers 500 instead of 304. The route's `onSend` returns `null` for a 304, and Fastify's automatic HEAD route then runs its own `onSend` on that `null` and throws.
  evidence: Story 9.12 Review Triage Log #1; reproduced (GET 200 with an ETag, then HEAD with that tag gave 500). Predates Story 9.12. Fix by returning `undefined` for a HEAD 304, or by declaring the HEAD route explicitly, with a test.
  target: Epic 4.
- source_spec: `spec-9-12-public-cors.md`
  summary: A malformed percent-encoding such as `/status/%E0` is answered by the router as a 400 with no CORS headers. A not-found handler would not cover it; it needs Fastify's `frameworkErrors`.
  evidence: Story 9.12 Review Triage Log #2; reproduced, 400 with no `access-control-allow-origin`. Settle with the 9.12 router-404 entry.
  target: Epic 4.
- source_spec: `spec-9-12-public-cors.md`
  summary: A cross-origin script can read the public page's 429 but not its `Retry-After`, because only `ETag` is exposed. Exposing `Retry-After` changes ARCHITECTURE 5.4.1 first; the same edit could say the headers go on every answer.
  evidence: Story 9.12 Review Triage Log #3 and #4.
  target: Epic 4.

## From Story 9.13 (2026-10-08)

- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Values inside a Postgres error still reach the logs. They appear in its `message` and `detail`, such as `invalid input syntax for type integer: "..."` or a unique-key violation's `Key (email)=(...)`, and in `where`, `hint` and `internal_query`. Story 9.13 redacts only the `parameters` and `args` properties. Redact or replace every field postgres.js copies onto the error before subscriber addresses are stored. Settle it with the 9.13 entry on nested errors: a recursive scrub in the serializers would likely hold both fixes.
  evidence: Story 9.13 Boundaries (Never) and Review Triage Log #7; `err.message` and `err.detail` are logged by `logFailure` and the worker.
  target: Epic 6 prerequisite.
- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Log redaction covers only top-level `err.parameters`, `err.args`, `error.parameters` and `error.args`. In debug mode, a database error wrapped in another error, inside an `AggregateError`, serialized through `ExceptionBase.toJSON` (which stringifies its `cause`), logged under another key, or printed with `console.error` (seed failures, the event bus's default reporter) still prints parameter values. Consider a recursive scrub in the `err`/`error` serializers before Epic 6, together with the 9.13 entry on values in Postgres error fields.
  evidence: Story 9.13 Review Triage Log #4 and #5. The Epic 9 retro (DR-5) confirmed the `cause` path: `ExceptionBase.toJSON` writes `cause: JSON.stringify(this.cause)` (`src/shared/exceptions/exception-base.ts:52`), and at debug level postgres.js makes `parameters` enumerable, so a database error passed as a cause would print its values. Unverified in practice: nothing in `src` passes a database error as a cause, and `DatabaseErrorException` exists but nothing constructs it today.
  target: Epic 6 prerequisite.
- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Record the logging rule in AGENTS.md: log database errors only as a top-level `err` or `error` through a pino logger, and give `postgres()` a `debug` option only through `sqlDebugOption`.
  evidence: Story 9.13 Review Triage Log #6; routed defer because the fix edits an agent-context file.
  target: Epic 6 prerequisite.

## From Story 9.14 (2026-10-08)

- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: DOMAIN's "v1 has no hard service delete" could note that a migration enforces it, as its `check_results` entry does. Changes DOMAIN first.
  evidence: Story 9.14 Tasks.
  target: Genesis edit (owner).
- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: Because the runtime role can insert and delete rows in dbmate's `schema_migrations`, a migration can be recorded as applied when it never ran (or hidden), so a revoke like this story's could appear applied while absent; a bare `dbmate up` or `down` as that role does exactly this. The fix is a migration revoking `watchdog_app`'s privileges on `schema_migrations`.
  evidence: Story 9.14 Code Map.
  target: Epic 8 (default).
- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: AGENTS.md says "Services are archived, never hard-deleted." as a convention. Note beside it that a migration revokes `DELETE` on `services` from `watchdog_app`, and that `service-delete-privilege.integration.test.ts` guards the grant, as the append-only bullet does for `incident_updates`.
  evidence: Story 9.14 Review Triage Log #8; routed defer because the fix edits an agent-context file.
  target: AGENTS.md edit.

## From Epic 9 retro item 1a (2026-10-08)

- source_spec: `spec-epic-9-retro-1a-service-read-ids.md`
  summary: The REST-versus-GraphQL row comparison covers service create only; service update and service-group create and update are not compared, though REST's null coercion can store different values there.
  evidence: Review Triage Log #8; `service-input-validation.integration.test.ts` "stores the same columns over REST and GraphQL" creates only. Settle it with the 9.1 REST null coercion entry.
  target: Epic 8 (default).
- source_spec: `spec-epic-9-retro-1c-incident-timeline-read-ids.md`
  summary: Nothing fails when a new id-taking GraphQL `Query` field ships without a malformed-id case, so its handler can skip `assertUuid` and answer a masked 500 again. The retro's DR-1 Prevention proposes 9.11's registry pattern applied to `Query` fields.
  evidence: Review Triage Log #2; every id-taking read has a hand-written malformed-id test today, but no test enumerates `Query` fields the way 9.11's registry enumerates mutations.
  target: Before the next id-taking GraphQL `Query` field is added.

## From Epic 9 retro item 2 (2026-10-08)

- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: No test runs the real worker's `shutdown`, so the DR-4 fix could be unwired (`shutdown` calling `app.close()` and `closeDbConnection()` directly again) and nothing would fail; `closeWorker` is tested only as a helper. Close it together with the 9.10 `startWorker` health-wiring entry, which needs the same seam to start the real worker.
  evidence: Review Triage Log #5; `closeWorker` is referenced only by `src/worker-health.integration.test.ts`, and the only test that starts the worker (`runtime-role.integration.test.ts:122-133`) exits before `shutdown` is registered.
  target: Epic 5.
- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: The api lists `closeDbConnection` unguarded in graceful-server's `closePromises` with `syncClose: true`, so a rejection there skips the remaining steps and the exit, the gap the worker's `closeWorker` now closes.
  evidence: Review Triage Log #12; `src/api.ts:34`, and the comment above it at `:19-23` describes the skip. Pre-existing.
  target: The next change to `src/api.ts`; Epic 8 (default) otherwise.
- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: `src/worker-health.ts:149` logs a failed heartbeat write as `{ error }`, which pino prints as `{}`, so the reason is lost. Use `{ err: error }`, as `src/worker.ts` now does.
  evidence: Review Triage Log #6; `fastify({ logger: true }).log.error({ error: new Error('boom') }, 'x')` prints `"error":{}`. Pre-existing, and the spec ruled `worker-health.ts` out of this change.
  target: Epic 5.

## From Epic 9 retro item 4 (2026-10-09)

- source_spec: `spec-epic-9-retro-4-shared-test-helpers.md`
  summary: Maintenance suites still define their own window fixture, which duplicates the shared `scheduleMaintenance`: `schedule` in `end-maintenance` and `read-maintenance`, and `createWindow` in `maintenance-input-validation`. Item 4 named only `createService`, `createGroup`, `declare`, `capturing` and `gql`, so these stayed. (`schedule-maintenance`'s and `maintenance-input-validation`'s `schedule` return the raw response for the test to assert on, so those are not fixtures.)
  evidence: Review Triage Log #3; `grep -rnE "(function|const) (schedule|createWindow)\b" src --include='*.test.ts'`.
  target: The next story that touches a maintenance suite.
- source_spec: `spec-epic-9-retro-4-shared-test-helpers.md`
  summary: 23 test files still declare `const ORIGIN = 'http://localhost:3000'`, a copy of `TEST_ORIGIN` from `src/shared/testing/tenant.ts`. Migrated files now send both: the fixtures send `TEST_ORIGIN`, the file's own requests send `ORIGIN`.
  evidence: Review Triage Log #4; `grep -rln "const ORIGIN = 'http://localhost:3000'" src`.
  target: The next story that touches one of those suites.
