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
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-4-graphql-maintenance-validation.md`, `spec-9-6-read-service-groups.md`, `spec-epic-9-retro-1a-service-read-ids.md`, `spec-5-2-list-a-services-monitors.md`
  summary: A uuid is not canonical when it reaches Postgres, and the caller gets a masked 500 instead of a 400. Two forms. `urn:uuid:<uuid>` passes the uuid format of both TypeBox and ajv, and Postgres refuses it. The same service UUID written in two letter cases passes `assertNoDuplicates` (an exact string compare) and hits the `maintenance_services` primary key, an unmapped 23505; incident `affectedServices` is likely the same. Every `format: 'uuid'` check is affected: the REST route params, the GraphQL mutation and read ids (`service(id)`, `incident(id)` over REST too, `incidentTimeline(id)`, `maintenanceWindow(id)`, `serviceGroup(id)`, `GET /api/v1/service-groups/:id`, and Story 5.2's `monitors(serviceId)` and `GET /api/v1/services/:serviceId/monitors`), and ids inside request bodies: `affectedServices[].serviceId` on incident create and update, `serviceGroupId` on service create and update, and the service ids of maintenance schedule and update. Decide whether `assertUuid` and the schemas should require the plain lowercase form, or normalize ids; one change could fix both.
  evidence: Story 9.1 Review Triage Log #20, Story 9.4 #15 and #16, Story 9.6 #6, retro 1a #13, and Story 5.2 E1/E5/B2. `typebox-guard.ts:78` checks `format: 'uuid'` only, and the `ajv-formats` uuid regex allows the `urn:uuid:` prefix. `maintenance.repository.ts` maps only 23503. The retro 1c review reproduced the `urn:uuid:` case for `incident(id)` and `incidentTimeline(id)` over both surfaces. Pre-existing on both surfaces.
  target: Epic 8 (default).
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-3-graphql-incident-validation.md`
  summary: Whitespace-only text is stored on both surfaces: service names, and an incident `message` on create and transition, whose schemas have `minLength: 1` without post-update's `pattern: '\S'`. Whether to refuse it is a product rule.
  evidence: Story 9.1 Review Triage Log #21 and Story 9.3 #14. Pre-existing on REST and GraphQL. Fixing it edits the TypeBox schemas.
  target: Epic 8 (default).
- source_spec: `spec-9-2-anonymous-graphql-rate-limit.md`
  summary: Authenticated callers are never rationed, and sign-up is open, so anyone can mint a session that exempts them from the GraphQL limit. Decide on an authenticated limit before production exposure.
  evidence: `isRationedGraphqlRequest` exempts any valid session; Better Auth sign-up needs no invitation.
  target: Before production exposure (Epic 8 at the latest).
- source_spec: `spec-9-1-graphql-service-validation.md`, `spec-9-4-graphql-maintenance-validation.md`, `spec-5-1-create-and-update-a-monitor.md`
  summary: REST bodies go through Fastify's default ajv options, which differ from GraphQL and from the handler's own schema check, and Postgres refuses what none of them stops. Every slice behaves this way, so it is one cross-cutting change, since the global options affect every REST route. (1) `null` is coerced (`coerceTypes`) to `0`, `false` or `""` before the handler, so REST accepts nulls GraphQL refuses and stores different values where GraphQL stores NULL: `displayOrder: null` gives 0, `enabled: null` becomes `false`, and a maintenance `description: null` on schedule or update is stored as `""` through the union's string branch. (2) Unknown keys are silently stripped (`removeAdditional`): a PATCH carrying `type`, a misspelled `config` key. (3) A U+0000 character in a string field (a monitor's name or keyword, a service's name) reaches Postgres, which rejects it in `text` and `jsonb`; the unmapped error is masked as a 500 instead of a 400. Unverified for monitors; the class is pre-existing for every slice. Settle which behaviour is intended.
  evidence: Story 9.1 Review Triage Log #22 and the Story 9.4 spec review probe (real Fastify with `updateMaintenanceRequestDtoSchema` answered `PATCH {"description":null}` with 200 and `{"description":""}`); Story 5.1 Review Triage Log loop-1 E1/E2/B11/E3 (`src/server/build-app.ts:36-40` sets only `keywords`, leaving `removeAdditional` and `coerceTypes` at Fastify's defaults) and loop-1 E11 and pass-2 E5 (settle (3) by sending `"name": "a\u0000b"` to `POST /api/v1/monitors` and reading the status). The retro 1a entry on REST-versus-GraphQL row comparison would catch a regression of (1).
  target: Epic 8 (default).
- source_spec: `spec-9-2-anonymous-graphql-rate-limit.md`
  summary: The anonymous GraphQL limiter looks up the session before checking the bucket, so a caller replaying a validly signed but signed-out session token costs one session query per request even after its bucket is spent. Unsigned or forged cookies cost nothing, because Better Auth refuses them before querying.
  evidence: Story 9.2 Review Triage Log #4; `node_modules/better-auth/dist/api/routes/session.mjs` returns null on a failed signed-cookie check before any query. Revisit with the 9.2 authenticated-limit entry.
  target: Before production exposure (Epic 8 at the latest).

## From Story 9.3 (2026-10-07)

- source_spec: `spec-9-3-graphql-incident-validation.md`, `spec-9-4-graphql-maintenance-validation.md`
  summary: A date that passes ajv's `date-time` on both surfaces can still be refused by Postgres as a masked 500. This covers an incident's `startedAt` and a maintenance window's `scheduledStartAt` and `scheduledEndAt`, and there are two causes. Year 0000, such as `0000-01-01T00:00:00Z`, is refused with "date/time field value out of range". An offset that pushes the instant past year 9999, such as `9999-12-31T23:59:59-23:59`, becomes a `Date` that postgres.js sends as `+010000-01-01T23:58:59.000Z`, and Postgres refuses that with "time zone displacement out of range". Postgres itself stores far later years, so the fix is to bound the accepted years, or to change how dates are serialized.
  evidence: Story 9.3 spec review probe and Review Triage Log #16, and Story 9.4 #14. ajv-formats accepts year 0000, and `new Date` parses it. Both Postgres errors were reproduced with a `::timestamptz` cast on 2026-10-09. postgres.js serializes a `Date` with `toISOString()` (`node_modules/postgres/src/types.js:31`). Pre-existing on REST and GraphQL.
  target: Epic 8 (default).
- source_spec: `spec-9-3-graphql-incident-validation.md`
  summary: `affectedServices` has no `maxItems`, so a very long list is validated in full before refusal; the message is capped at ten fields but the work is not.
  evidence: Story 9.3 Review Triage Log #15; bounded by the body limit, pre-existing on both surfaces.
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
  summary: No test proves the api's shutdown finishes `fastify.close()` (drain, auth pool) before `closeDbConnection()`; removing `syncClose: true` would pass every suite.
  evidence: Story 9.9 Review Triage Log #7. A meaningful test spawns the api, starts a slow event handler, sends SIGTERM and checks the handler's database work completed.
  target: Epic 8 (boot and container checks, audit F-11).

## From Story 9.13 (2026-10-08)

- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Values inside a Postgres error still reach the logs. They appear in its `message` and `detail`, such as `invalid input syntax for type integer: "..."` or a unique-key violation's `Key (email)=(...)`, and in `where`, `hint` and `internal_query`. Story 9.13 redacts only the `parameters` and `args` properties. Redact or replace every field postgres.js copies onto the error before subscriber addresses are stored. Settle it with the 9.13 entry on nested errors: a recursive scrub in the serializers would likely hold both fixes.
  evidence: Story 9.13 Boundaries (Never) and Review Triage Log #7; `err.message` and `err.detail` are logged by `logFailure` and the worker.
  target: Epic 6 prerequisite. Story 6.1 (written 2026-10-21) carries it.
- source_spec: `spec-9-13-sql-log-redaction.md`
  summary: Log redaction covers only top-level `err.parameters`, `err.args`, `error.parameters` and `error.args`. In debug mode, a database error wrapped in another error, inside an `AggregateError`, serialized through `ExceptionBase.toJSON` (which stringifies its `cause`), logged under another key, or printed with `console.error` (seed failures, the event bus's default reporter) still prints parameter values. Consider a recursive scrub in the `err`/`error` serializers before Epic 6, together with the 9.13 entry on values in Postgres error fields.
  evidence: Story 9.13 Review Triage Log #4 and #5. The Epic 9 retro (DR-5) confirmed the `cause` path: `ExceptionBase.toJSON` writes `cause: JSON.stringify(this.cause)` (`src/shared/exceptions/exception-base.ts:52`), and at debug level postgres.js makes `parameters` enumerable, so a database error passed as a cause would print its values. Unverified in practice: nothing in `src` passes a database error as a cause, and `DatabaseErrorException` exists but nothing constructs it today.
  target: Epic 6 prerequisite. Story 6.1 (written 2026-10-21) carries it.

## From Story 9.14 (2026-10-08)

- source_spec: `spec-9-14-revoke-service-delete.md`
  summary: Because the runtime role can insert and delete rows in dbmate's `schema_migrations`, a migration can be recorded as applied when it never ran (or hidden), so a revoke like this story's could appear applied while absent; a bare `dbmate up` or `down` as that role does exactly this. The fix is a migration revoking `watchdog_app`'s privileges on `schema_migrations`.
  evidence: Story 9.14 Code Map.
  target: Epic 8 (default).

## From Epic 9 retro item 1a (2026-10-08)

- source_spec: `spec-epic-9-retro-1a-service-read-ids.md`
  summary: The REST-versus-GraphQL row comparison covers service create only; service update and service-group create and update are not compared, though REST's null coercion can store different values there.
  evidence: Review Triage Log #8; `service-input-validation.integration.test.ts` "stores the same columns over REST and GraphQL" creates only. Settle it with the REST request options entry.
  target: Epic 8 (default).

## From Epic 9 retro item 2 (2026-10-08)

- source_spec: `spec-epic-9-retro-2-worker-health-idle-passes.md`
  summary: The api lists `closeDbConnection` unguarded in graceful-server's `closePromises` with `syncClose: true`, so a rejection there skips the remaining steps and the exit, the gap the worker's `closeWorker` now closes.
  evidence: Review Triage Log #12; `src/api.ts:34` lists `closeDbConnection` bare, `:25` sets `syncClose: true`, and the comment at `:19-24` describes the skip. Pre-existing.
  target: The next change to `src/api.ts`; Epic 8 (default) otherwise.

## From Epic 9 retro item 4 (2026-10-09)

- source_spec: `spec-epic-9-retro-4-shared-test-helpers.md`
  summary: Maintenance suites still define their own window fixture, which duplicates the shared `scheduleMaintenance`: `schedule` in `end-maintenance` and `read-maintenance`, and `createWindow` in `maintenance-input-validation`. Item 4 named only `createService`, `createGroup`, `declare`, `capturing` and `gql`, so these stayed. (`schedule-maintenance`'s and `maintenance-input-validation`'s `schedule` return the raw response for the test to assert on, so those are not fixtures.)
  evidence: Review Triage Log #3; `grep -rnE "(function|const) (schedule|createWindow)\b" src --include='*.test.ts'`.
  target: The next story that touches a maintenance suite.
- source_spec: `spec-epic-9-retro-4-shared-test-helpers.md`
  summary: 22 test files still declare `const ORIGIN = 'http://localhost:3000'`, a copy of `TEST_ORIGIN` from `src/shared/testing/tenant.ts`. Migrated files now send both: the fixtures send `TEST_ORIGIN`, the file's own requests send `ORIGIN`.
  evidence: Review Triage Log #4; `grep -rln "const ORIGIN = 'http://localhost:3000'" src`.
  target: The next story that touches one of those suites.

## From Story 5.6 (2026-10-16)

- source_spec: `spec-5-6-record-a-check-result-and-count-consecutive-failures.md`
  summary: Recording a check result can deadlock with an organization delete. The record takes the monitor's row lock, then the foreign key's `for key share` on `"organization"`; the delete takes the organization row, then cascades into `monitors`. Postgres aborts one after 1 s, so either the org delete fails once or one result for a dying organization is lost. The fix reverses 5.6's frozen lock-first order or locks a Better Auth row from monitoring. The 5.6 Code Map's "no deadlock path" is wrong for this case.
  evidence: Review Triage Log B3; the migration's own note at `db/migrations/20261009130000_create_check_results.sql:84`. Deferred by the owner at the start of Story 5.7 (2026-10-16). Settle with a concurrency test racing an org delete against `recordCheckResultCommand`.
  target: Epic 8 (default).

## From Story 5.9 (2026-10-16)

- source_spec: `spec-5-9-run-checks-on-the-worker-s-own-loop.md`
  summary: The real worker's SIGTERM path is now tested, but shutdown's use of `closeWorker` (the pool still ends when `app.close()` fails, DR-4) is proven only by the `closeWorker` unit-level test. Shutdown calling `app.close()` and `closeDbConnection()` directly would pass every happy-path test. Settling it needs a fault-injection seam in `startWorker`.
  evidence: Review of Story 5.9; the retro item 2 shutdown entry, removed with this story, had this half still open.
  target: Epic 8 (default).

## From Story 5.12 (2026-10-17)

- source_spec: `spec-5-12-fill-the-90-day-uptime-in-the-public-payload.md`
  summary: `ROLLUP_RETENTION_DAYS` accepts values below 90. Pruning would then empty the older part of every public 90-day bar, and those days would read as "no checks ran". The minimum could be the window length.
  evidence: Review Triage Log E1; `src/config/check-results-env.ts` (minimum 1, from 5.11's frozen rule); DOMAIN, Public status page.
  target: Epic 8 (default).

## From Story 5.13 (2026-10-17)

- source_spec: `spec-5-13-order-the-admin-timeline-by-sequence-not-the-clock.md`
  summary: `sequence` is insert order, not commit order. Two posted updates hold only `for share` and can commit in either order, so a reader can see N+1 before N exists. A notification cursor moved from the stamp to `sequence` would still need its overlap.
  evidence: Review pass 1, E3/B3. The same holds for `created_at` today; ARCHITECTURE's cursor "reads with an overlap".
  target: Epic 6, the notification pass's cursor (ARCHITECTURE 5.6). Retargeted 2026-10-18 while writing Epic 4's stories: Epic 4 keeps no cursor, since a public stream starts from the current page and an admin subscription carries signals only (ARCHITECTURE 5.4). Story 6.6 (written 2026-10-21) carries it: its cursor re-reads `NOTIFICATION_CURSOR_OVERLAP_SECONDS` behind itself.
- source_spec: `spec-5-13-order-the-admin-timeline-by-sequence-not-the-clock.md`
  summary: The `incident_updates_sequence` backfill and its `setval` run only against an empty table in CI, and no test starts from pre-migration data. They were checked by hand on 119 local rows.
  evidence: Review pass 1, B9/V1. The repo has no pattern for testing a migration against existing rows. Settle it with one if a later migration also backfills.
  target: Epic 8 (default).

## From the Epic 5 retrospective (2026-10-17)


- source_spec: `spec-5-6-record-a-check-result-and-count-consecutive-failures.md`, `spec-5-15-open-a-draft-when-a-monitor-breaches-its-threshold.md`, `spec-5-16-reconcile-missed-drafts-each-pass.md`
  summary: The two draft paths disagree about archived services. A check in flight when its service is archived can still open a critical draft through the event path, while the 5.16 reconciler never would. The window is one check timeout. Make the event path refuse an archived service and a disabled monitor, as the reconciler does, and test it by archiving mid-flight.
  evidence: Epic 5 retro DR-2. 5.6 rejected E2 ("A service archived while its check is in flight still gets state events") on the premise that "5.10 and 5.15 consumers read the service themselves". 5.10 does (`recompute-service-status.integration.test.ts:680`); 5.15 does not (`create-draft-from-monitor.handler.ts` never reads the service, and `insertDraftIfAbsent` in `incident.repository.ts` checks only other incidents); `listAtThreshold` in `monitor.repository.ts` filters `m.enabled and s.archived_at is null`. No case in `monitor-draft.integration.test.ts` or `record-check-result.integration.test.ts` archives a service.
  target: Epic 8 (default); Epic 5 retro item 2.
- source_spec: `spec-5-3-keep-check-results-in-monthly-partitions.md`, `spec-5-11-refresh-daily-uptime-rollups.md`
  summary: Partition retention does not wait for a failed rollup. `runWorkerPass` runs partition maintenance whatever `orgFailed` says, so an organization whose refresh fails on every pass for `CHECK_RESULTS_RETENTION_DAYS` (30) loses those days; they are logged as "lost to retention". Decide whether maintenance should skip, or keep, the months an unrefreshed organization still needs.
  evidence: Epic 5 retro DR-3; `src/worker.ts` runs maintenance after the organization loop whatever `failed` is, and `check-result-partitions.integration.test.ts:559` and `:583` pin that it still runs. ARCHITECTURE 6.1 now records the exception.
  target: Epic 8 (default).
- source_spec: `spec-5-3-keep-check-results-in-monthly-partitions.md`
  summary: The `SECURITY DEFINER` drop function takes any retention of at least 1 day from `watchdog_app`, so the append-only revoke on `check_results` does not stop the application role dropping every month but the current one. A floor on the argument (or on `CHECK_RESULTS_RETENTION_DAYS`) is a genesis decision, since ARCHITECTURE 6.1 decided the argument is passed in.
  evidence: Epic 5 retro DR-3; `db/migrations/20261009130000_create_check_results.sql` (`p_retention_days < 1` is the only check) and `src/config/check-results-env.ts` (minimum 1).
  target: Epic 8 (default), changing ARCHITECTURE 6.1 first (owner).
- source_spec: `spec-5-1-create-and-update-a-monitor.md`
  summary: The target guard leaves NAT64 and CGNAT open. A hostname whose AAAA record is `64:ff9b::a9fe:a9fe` reaches `169.254.169.254` on a host with a NAT64 gateway. Classify `64:ff9b::/96` and `64:ff9b:1::/48` by the IPv4 address they embed, as IPv4-mapped addresses already are, and decide CGNAT (`100.64.0.0/10`). Change ARCHITECTURE 6.5 first.
  evidence: Epic 5 retro DR-5 and decision 3. ARCHITECTURE 6.5 lists the ranges the rule does not classify; the omission is a recorded decision (spec-5-1 B4/B5/E6/E7) with no reason given.
  target: Before production exposure; Epic 5 retro item 4 (owner decides the rule, then the dev loop).
- source_spec: `spec-5-1-create-and-update-a-monitor.md`, `spec-5-4-http-and-keyword-checks-behind-the-target-guard.md`
  summary: The check-time guard uses the same one-try resolver as configure time, so one dropped DNS packet is a failed check, and a hostname known only to `/etc/hosts` never resolves at check time. Decide whether the connect-time guard should retry, and how it should treat `/etc/hosts`.
  evidence: Epic 5 retro DR-6. `guardHost` falls back to `defaultLookup` (`guarded-connect.ts:122`), which is `new Resolver({ timeout, tries: 1 })` (`target-safety.ts:279`). ARCHITECTURE 6.5 now says both times share it.
  target: Epic 8 (default).
- source_spec: `spec-5-4-http-and-keyword-checks-behind-the-target-guard.md`
  summary: A server that ignores `accept-encoding: identity` and returns gzip makes a keyword check search compressed bytes.
  evidence: Epic 5 retro, lower findings; `src/modules/monitoring/checks/http-check.ts:56`; spec-5-4 E2.
  target: Epic 8 (default).
- source_spec: `spec-5-9-run-checks-on-the-worker-s-own-loop.md`
  summary: The process-wide check limiter's `close()` is permanent, so a second `startWorker` in one process runs no checks. Only tests do that.
  evidence: Epic 5 retro, lower findings; `src/modules/monitoring/checks/process-check-limiter.ts`, `src/worker.ts` (shutdown).
  target: Epic 8 (default).
- source_spec: `spec-5-11-refresh-daily-uptime-rollups.md`
  summary: An organization deleted mid-pass fails its rollup step with `23503`, logged at `error` level; it was seen 11 times during one integration run. Decide whether a vanished organization's foreign-key failure should be a skip rather than an error.
  evidence: Epic 5 retro, lower findings and behavior verification; spec-5-11 B8/E2 predicted it.
  target: Epic 8 (default).
- source_spec: `spec-5-9-run-checks-on-the-worker-s-own-loop.md`
  summary: VG-2. "Drains event handlers" on SIGTERM is never shown with a handler pending; the lifecycle test checks only that the close steps log no failure. Add a case with a slow event handler in flight when the signal arrives.
  evidence: Epic 5 retro VG-2; `worker-lifecycle.integration.test.ts:293`. The api half is the Story 9.9 entry above.
  target: Epic 8 (default).
- source_spec: `spec-5-16-reconcile-missed-drafts-each-pass.md`
  summary: VG-3. "The monitor is still checked" after a dismissed draft is shown by calling `recordCheckOutcome` directly, not through the monitor loop.
  evidence: Epic 5 retro VG-3; `draft-reconciliation.integration.test.ts:328`.
  target: Epic 8 (default).
- source_spec: `spec-5-11-refresh-daily-uptime-rollups.md`
  summary: VG-4. "Rollups survive the raw partitions being dropped" is never combined with an actual partition drop; the test checks the rollup rows alone.
  evidence: Epic 5 retro VG-4; `uptime-rollups.integration.test.ts:490`.
  target: Epic 8 (default).
- source_spec: `spec-5-6-record-a-check-result-and-count-consecutive-failures.md`
  summary: VG-5. A monitor disabled while a check is in flight is tested for a failure only, not for a success.
  evidence: Epic 5 retro VG-5; `record-check-result.integration.test.ts:418`.
  target: Epic 8 (default).

## From Story 4.1 (2026-10-18)

- source_spec: `spec-4-1-every-answer-under-status-carries-the-public-headers.md`
  summary: Paths that differ from `/status` only in letter case, such as `/STATUS/x/`, are not the public page's path. They keep the root 404 and the router's echo of the path.
  evidence: Story 4.1 Boundaries (Never).
  target: Epic 8 (default).
- source_spec: `spec-4-1-every-answer-under-status-carries-the-public-headers.md`
  summary: Triage row #14. AGENTS.md should note the `/status` catch-all route, `frameworkErrors`, and that a not-found handler doubles as the app-wide bad-URL handler (Fastify wires the last-set one into its 404 router's `onBadUrl`, so a throwing one crashes the process).
  evidence: Story 4.1 Review Triage Log #14 and #1.
  target: AGENTS.md edit (next AGENTS.md reconciliation). RESOLVED by Epic 4 retro item 1 (2026-10-21): AGENTS.md's Known pitfalls says never to call `setNotFoundHandler`, and names the `/status` catch-all routes and `frameworkErrors`.
- source_spec: `spec-4-1-every-answer-under-status-carries-the-public-headers.md`
  summary: A cross-origin preflight to a router miss (`OPTIONS /status/x/`) or to a malformed URL (`OPTIONS /status/%E0`) gets a 404 or 400, and a browser fails any non-2xx preflight. So a conditional (`If-None-Match`) fetch of a missing page is opaque to the script even though the answer carries the public headers. A plain fetch is not preflighted and reads the miss.
  evidence: Story 4.1 Review Triage Log #21. The same was true on master. Answering preflights under `/status` with 204 plus the allowed methods and headers would fix it.
  target: Epic 8 (default). Retargeted 2026-10-20 by story 4.5 (owner): 4.5 added only its own stream's preflight, `OPTIONS /status/:orgSlug/events`, admitting `Last-Event-ID`; preflights to misses under `/status` still get the 404 or 400.

- source_spec: `docs/bmad/implementation-artifacts/spec-4-3-bridge-domain-events-to-notify.md`
  summary: Re-check ARCHITECTURE 5.3's NOTIFY bridge sketch against DOMAIN's updated channel sketch (payload built by the application and sent as one parameter; the `uptime.rollup_refreshed` aggregate is the organization).
  evidence: Story 4.3 changed DOMAIN's sketch, the owning document; the frozen intent allowed no other genesis edit. ARCHITECTURE 5.3 still shows `json_build_object` and does not name the uptime aggregate. Its semantics (six keys, emit-time `occurredAt`) already match.
  target: Next ARCHITECTURE reconciliation (owner). RESOLVED by Epic 4 retro item 1 (2026-10-21): ARCHITECTURE 5.3's sketch builds the payload in the application and sends it as one parameter, and its As built note names the `uptime.rollup_refreshed` aggregate.

- source_spec: `docs/bmad/implementation-artifacts/spec-4-4-listen-in-the-api-and-fan-out-per-organization.md`
  summary: AGENTS.md should record story 4.4's conventions. `buildApp(overrides, { listen })` opens a dedicated `watchdog-listener:<pid>` connection, a name shared by every listening app in one process. The test sentinel is `uptime.rollup_refreshed` with `aggregateType: 'test.sentinel'`, which admin subscribers in a listening test app receive unless they filter it. `subscribeForOrg` and `notifyRaw` are the helpers.
  evidence: Story 4.4 Review Triage Log #12. The fix edits an agent-context file, which the owner has held until the open row #14 is reconciled.
  target: AGENTS.md edit (next AGENTS.md reconciliation, with row #14). RESOLVED by Epic 4 retro item 1 (2026-10-21): AGENTS.md's Known pitfalls records `buildApp(overrides, { listen: true })`, `watchdog-listener:<pid>`, the sentinel, `subscribeForOrg` and `notifyRaw`.

## From Story 4.5 (2026-10-20)

- source_spec: `docs/bmad/implementation-artifacts/spec-4-5-open-a-public-status-stream.md`
  summary: The public stream's writes ignore backpressure. Before 4.6 pushes full pages, a stream needs a policy for a reader that does not drain, such as ending it once `writableLength` passes a bound.
  evidence: Story 4.5 Review Triage Log #5. In 4.5 a stream writes one page and then a 13-byte heartbeat every 30 s. With 4.6's pushes, up to 1,000 streams could each buffer whole pages without bound.
  target: Epic 4, story 4.6. RESOLVED by story 4.6 (2026-10-20): while a socket has not drained a stream is sent no page and no heartbeat, and on `drain` gets only the newest page if its ETag differs; a stream holds at most one page.
- source_spec: `docs/bmad/implementation-artifacts/spec-4-5-open-a-public-status-stream.md`
  summary: The stream caps key on the full socket address, so one actor with many addresses, or an IPv6 /64, can hold every `PUBLIC_STREAM_MAX_TOTAL` place and leave every organization's viewers with a 429.
  evidence: Story 4.5 Review Triage Log #12. Keying on the full address is ARCHITECTURE 5.4.1's decision, shared with the rate limit (F-18). Prefix grouping or a per-organization share would be a new policy, and the owner has not recorded it as an accepted risk.
  target: Epic 8 (default).
- source_spec: `docs/bmad/implementation-artifacts/spec-4-5-open-a-public-status-stream.md`
  summary: ARCHITECTURE 5.4.1 should record `PUBLIC_STREAM_HEARTBEAT_SECONDS` (default 30), the stream's heartbeat interval, which is not a bound but is part of the stream's contract.
  evidence: Story 4.5 Review Triage Log #2. Story 4.5 added the setting, and the owner allowed only the 7.1 genesis edit. 5.4.1 names three stream bounds and no heartbeat.
  target: Next ARCHITECTURE reconciliation (owner). RESOLVED by Epic 4 retro item 1 (2026-10-21): ARCHITECTURE 5.4.1 records the heartbeat and `PUBLIC_STREAM_HEARTBEAT_SECONDS`.

## From Story 4.6 (2026-10-21)

- source_spec: `docs/bmad/implementation-artifacts/spec-4-6-push-the-public-page-when-it-changes.md`
  summary: The route's backpressure wiring has no test. Nothing covers the `drain` listener calling `member.drained()`, the heartbeat skipped while the socket needs draining, or the heartbeat re-armed on `drain`.
  evidence: Story 4.6 Review Triage Log #6. The unit spec drives only `createPagePush`. Deleting any of those lines keeps every test green. A real socket cannot be stalled deterministically, so a test needs a seam over `reply.raw` or a fake response.
  target: Epic 8 (default).
- source_spec: `docs/bmad/implementation-artifacts/spec-4-6-push-the-public-page-when-it-changes.md`
  summary: Removing `member?.leave()` from the stream's cleanup fails no test, and a dead member would be held for the life of the process.
  evidence: Story 4.6 Review Triage Log #8. A dead member is unobservable from a test without a member count on the push, which is new surface.
  target: Epic 8 (default).
- source_spec: `docs/bmad/implementation-artifacts/spec-4-6-push-the-public-page-when-it-changes.md`
  summary: A slug rename or an organization deletion emits no event, so an open stream keeps showing the page until its lifetime ends, while `GET` already answers 404.
  evidence: Story 4.6 Review Triage Log #12. Neither Better Auth hook emits a domain event. The bound is `PUBLIC_STREAM_MAX_LIFETIME_SECONDS` (3,600 by default).
  target: Epic 8 (default).
- source_spec: `docs/bmad/implementation-artifacts/spec-4-6-push-the-public-page-when-it-changes.md`
  summary: ARCHITECTURE 5.4.1 should record the stream's backpressure rule: the latest page wins, and a stream holds at most one page in its buffer.
  evidence: Story 4.6 Review Triage Log #13. The owner decided the rule on 2026-10-20. It is a runtime bound of the anonymous surface, which ARCHITECTURE owns, and editing `docs/genesis` needs the owner.
  target: Next ARCHITECTURE reconciliation (owner). RESOLVED by Epic 4 retro item 1 (2026-10-21): ARCHITECTURE 5.4.1 records the backpressure rule.
- source_spec: `docs/bmad/implementation-artifacts/spec-4-6-push-the-public-page-when-it-changes.md`
  summary: A `resync` composes every organization with an open stream at once, and every composition draws on the shared pool.
  evidence: Story 4.6 Review Triage Log #21. This happens only when LISTEN reconnects, bounded by the number of organizations with streams (at most `PUBLIC_STREAM_MAX_TOTAL`). A concurrency cap would be a new policy.
  target: Epic 8 (default).

## From Story 4.7 (2026-10-21)

- source_spec: `docs/bmad/implementation-artifacts/spec-4-7-subscribe-to-organization-events-over-graphql.md`
  summary: There is no cap on concurrent authenticated WebSocket subscriptions, per user or per IP. Any valid session, and sign-up is open, can hold as many sockets as it likes, each with up to 10 hub subscriptions and a queue of up to `MAX_QUEUED_SIGNALS` signals for each.
  evidence: Story 4.7 spec, Never: "No per-user or per-IP cap on concurrent authenticated sockets." Only an upgrade without a valid session is rationed (ARCHITECTURE 5.4.1, 5.5), a socket with no accepted subscription is closed 10 s after its upgrade, and one socket holds at most `MAX_SUBSCRIPTIONS_PER_SOCKET` (10) live subscriptions; the number of authenticated sockets has no bound. Revisit with the Story 9.2 authenticated-limit entry.
  target: Epic 8.
- source_spec: `docs/bmad/implementation-artifacts/spec-4-7-subscribe-to-organization-events-over-graphql.md`
  summary: Admin subscription sockets have no keep-alive or ping, so a client that vanishes without a FIN keeps its socket, hub subscription and signal queue until the OS's TCP timeout.
  evidence: Story 4.7 Review Triage Log #13. mercurius `keepAlive` is unset and nothing pings. Choosing an interval is a policy the spec did not settle.
  target: Epic 8 (default).
- source_spec: `docs/bmad/implementation-artifacts/spec-4-7-subscribe-to-organization-events-over-graphql.md`
  summary: ARCHITECTURE 5.5 says an upgrade without a valid session "is refused". In fact the upgrade is answered 101 and `connection_ack`, and the refusal (`UNAUTHENTICATED`, close 4401) comes at `subscribe`, with a 10 s deadline closing any socket that never has a subscription accepted.
  evidence: Story 4.7 Review Triage Log #14. The owner allowed one 5.5 sentence in this story, so the wording is left for the owner.
  target: Next ARCHITECTURE reconciliation (owner). RESOLVED by Epic 4 retro item 1 (2026-10-21): ARCHITECTURE 5.5 says the upgrade is answered 101 and `connection_ack`, the refusal comes at `subscribe` with 4401, and the 10 s deadline closes with 4408.
- source_spec: `docs/bmad/implementation-artifacts/spec-4-7-subscribe-to-organization-events-over-graphql.md`
  summary: Story 4.8's access re-check must also reset a socket's cached admission (`state.admission` in `organization-events.resolver.ts`), not only close live subscriptions. Otherwise a later subscribe on the same socket is admitted from the first lookup after the session or membership is gone.
  evidence: Story 4.7 Review Triage Log #30. The admission is resolved once per socket and kept for its lifetime.
  target: Epic 4, story 4.8. RESOLVED by story 4.8 (2026-10-21): once a socket has an accepted subscription it re-checks its access every `ADMIN_SUBSCRIPTION_RECHECK_SECONDS`, idle or not, and closes on loss (4401) or a failed lookup (4500). The cached admission ends with the socket, so it never outlives access by more than one interval plus the next re-check's lookup, which is cut off at min(interval, 10 s).

## From Story 4.8 (2026-10-21)

- source_spec: `docs/bmad/implementation-artifacts/spec-4-8-close-a-subscription-when-access-is-lost.md`
  summary: Admin sockets accepted together re-check their access in lockstep, and any transient slow or failed lookup closes all of them with 4500 at once, so they reconnect together. The lookup deadline also shrinks with the interval (`min(interval, 10 s)`), so a 1 s interval gives the database a 1 s budget.
  evidence: Story 4.8 Review Triage Log #9. There is no jitter and no retry before a fail-closed close. Choosing jitter, a fixed lookup budget or a retry is a policy the story's frozen rules do not settle.
  target: Epic 8 (default).
- source_spec: `docs/bmad/implementation-artifacts/spec-4-8-close-a-subscription-when-access-is-lost.md`
  summary: ARCHITECTURE 5.5 says the session, active organization and membership are re-checked. Story 4.8's AC instead keeps the organization a subscription was admitted for when the operator switches their active one, and re-checks membership of that organization.
  evidence: Story 4.8 Review Triage Log #10, `docs/genesis/ARCHITECTURE.md:450`. The AC owns the behaviour, and editing `docs/genesis` needs the owner.
  target: Next ARCHITECTURE reconciliation (owner). RESOLVED by Epic 4 retro item 1 (2026-10-21): ARCHITECTURE 5.5 says the re-check keeps the organization the socket was admitted for.

## From Story 4.9 (2026-10-21)

- source_spec: `docs/bmad/implementation-artifacts/spec-4-9-prove-worker-events-reach-api-clients-under-compose.md`
  summary: ARCHITECTURE still describes the `compose` job as `docker compose --profile app up` (the "Decided 2026-10-18" paragraph after section 9's table). Section 8 says the `app` profile stays down while the integration suites run, without the `watchdog-backplane` exception AGENTS.md now states, and it does not list `docker-compose.backplane.yml`. The reworded line 866 still sits under the "Planned checks, not current CI coverage" lead-in.
  evidence: Story 4.9 Review Triage Log #11. The owner allowed only the section 9 row and the line 866 rewording in this story.
  target: Next ARCHITECTURE reconciliation (owner). RESOLVED by Epic 4 retro item 1 (2026-10-21): section 8 records `docker-compose.backplane.yml` and the `watchdog-backplane` exception, and section 9's decision paragraph describes the separate project.
