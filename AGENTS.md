# watchdog

Self-hosted, multi-tenant status page platform. TypeScript on Node 24, Fastify 5, pnpm, raw SQL over `postgres.js`, Postgres row-level security for tenant isolation, CQRS with vertical slices. The specifications of record live in `docs/genesis/`; BMAD planning and story artifacts live in `docs/bmad/`.

## Policy

- Never edit a migration that has been applied. Schema changes arrive as new migrations. dbmate tracks by version and does not checksum content, so correcting a comment is safe; changing DDL is not.
- Never edit `docs/genesis/*` to match code that drifted. A decision changes in its owning document first — `DOMAIN.md` owns the data and behaviour model, `ARCHITECTURE.md` owns runtime wiring — then the others are re-checked.
- Never hand-edit `db/better-auth-schema.sql`. Regenerate it with `pnpm run auth:schema:generate`.
- Branch and open a PR; the pre-commit hook runs lint-staged, `tsc`, dependency-cruiser and unit tests.

## Where things are

- Vertical slices: `src/modules/<feature>/{commands,queries,domain,database,dtos}`
- Tenant-scoped database access: `src/shared/db/tenant-transaction.ts`
- Cross-module event contracts: `src/shared/events/`
- Better Auth instance: `src/server/auth/auth.ts`; the Fastify plugin that mounts it: `src/server/plugins/auth.ts`; active-org and role resolution: `src/server/auth/organization-context.ts`; the frozen FK contract: `db/better-auth-schema.sql`
- Configuration: `src/config/env.ts` for the application, `src/config/auth-env.ts` for the subset Better Auth needs
- Entrypoints: `src/index.ts` dispatches to `src/api.ts` or `src/worker.ts` on `process.argv[2]`; both the api and the tests build the instance through `src/server/build-app.ts`
- Writing a migration or a query against tenant data? Read `docs/genesis/DOMAIN.md` first — RLS policy shape, the GUC contract, and the canonical event catalog.

## Running and verifying

- `pnpm run check` is Biome, `tsc --noEmit` and dependency-cruiser. CI runs the same thing.
- `pnpm run test` is unit only and needs no database.
- `pnpm run test:integration` needs `docker compose up -d` and a `DATABASE_URL` pointing at `watchdog_app`. Pointed at the owner role it fails on its first assertion rather than passing vacuously.
- `pnpm run auth:schema:check` needs a migrated database; it is not part of `pnpm run check`.
- Run both of the above locally before pushing. Neither can run in `pnpm run check` because both need a live database, so CI's `database` job is otherwise their first execution.
- After changing dependencies in `package.json`, run `pnpm install --lockfile-only` before anything using `--frozen-lockfile`, including the Docker build.

## Conventions that differ from defaults

- REST routes live under `/api`, applied by the `prefix` option `@fastify/autoload` hands each plugin. `autoPrefix` is a property a plugin file exports, not a loader option; the boilerplate passed it as one and served everything at `/v1` instead.
- Tenant-scoped repositories take a `TenantTransaction` per call rather than closing over the global connection, which has no `app.current_org_id` set and would see nothing. They deliberately do not implement `RepositoryPort`.
- Every read or write of a tenant-scoped table goes through `withTenantTransaction`. `SET LOCAL` is transaction-scoped, so SQL issued outside one silently sees nothing.
- Double-quote every Better Auth identifier. `"user"` is a reserved word in Postgres, `"teamMember"` is camelCase, and every Better Auth column is camelCase. WatchDog's own tables stay snake_case, so a join across the two quotes one side only.
- `org_id` is `text` because Better Auth ids are 32-character strings; WatchDog-native primary keys are `uuid`. Policies compare text to text and need no `::uuid` cast.
- Status ladders are `text` with a `CHECK` constraint, never Postgres enum types — a ladder change should be a one-line migration.
- Read configuration only through `src/config/`. env-schema validates `.env` into an object and never writes to `process.env`, so a module reading `process.env` directly sees nothing from `.env`.
- Modules never import each other. Cross-module contracts go in `src/shared/events/` with their own payload types, not a re-export of the emitting module's DTO. `dependency-cruiser` enforces this.
- Services are archived, never hard-deleted.
- Append-only tables revoke `UPDATE` and `DELETE` from `watchdog_app` in their migration. A repository that merely omits the methods is not enforcement; anything holding a tenant transaction can write raw SQL. RLS policies alone would make an edit a silent no-op rather than an error. `incident_updates` does this, and `check_results` must when it arrives.

## Known pitfalls

- An unset `app.current_org_id` reads back as `''`, not NULL, on any connection that has previously set it — a custom GUC reverts to its reset value. Never write a policy that treats unset as unrestricted: no `is null` branch, no `coalesce` over the GUC. Both forms fail closed today; only one keeps doing so.
- pnpm 12 reads settings from `pnpm-workspace.yaml` (`allowBuilds`), not from a `pnpm` key in `package.json`, which it silently ignores.
- The `dev` script's `--env-file` sits after the entry path, so tsx forwards it to the app as argv and it has no effect. `.env` reaches the application only through `src/config`.
- `@fastify/autoload` scans `src/server/plugins` recursively and evaluates what it finds at boot. Put anything that is not a Fastify plugin elsewhere; that is why the Better Auth instance lives in `src/server/auth/`.
- postgres.js declares `TransactionSql` as `Omit<Sql, ...>`, which drops the call signature, so `tx\`select ...\`` looks untyped. Use `TenantTransaction` from `src/shared/db/tenant-transaction.ts`, which absorbs the cast.
- Container healthchecks must target `127.0.0.1`, not `localhost`. Inside a container `localhost` resolves to `::1` first while Fastify binds IPv4, and the probe is refused.
- Better Auth rejects a cookie-authenticated state change that arrives without an `Origin` matching `BETTER_AUTH_URL` or a trusted origin, with `MISSING_OR_NULL_ORIGIN`. Browsers send it; `app.inject` and `curl` do not.
- Better Auth's `invite-member` works with no `sendInvitationEmail` configured and returns the invitation, so a test can accept it directly. Building membership through invite plus accept is preferable to inserting into `"member"`, which would prove the query works and leave the plugin's behaviour untested.
- `Headers.forEach` folds repeated headers into one comma-joined value, which corrupts `Set-Cookie`. Use `getSetCookie()` when translating a `Response` back to a Fastify reply.
- Upgrading `better-auth` is expected to fail `auth:schema:check`. Fix it with a new migration plus a regenerated `db/better-auth-schema.sql`.
- A new table carrying `org_id` needs RLS enabled, `FORCE`d, and a policy. `src/shared/db/tenant-rls-coverage.integration.test.ts` fails otherwise; behavioural tests will not catch it.
