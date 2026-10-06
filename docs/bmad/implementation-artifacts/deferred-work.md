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
  summary: A malformed id on a query (`query { service(id: "not-a-uuid") }`) is still a masked 500, because query handlers do not call `assertUuid`.
  evidence: pinned by the test 'masks a database error a real resolver lets through, not only an injected one' in `graphql-error-formatter.integration.test.ts`; the fix changes that test with it.
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
  summary: A second `buildApp()` in the same process reportedly answers `publicStatusPage` with a masked 500, "Command type of status_page/page.get is not registered", which suggests CQRS handler registration is process-global. Unverified, medium if true, because any test needing a fresh app instance would hit it.
  evidence: Story 9.2 Review Triage Log #8, observed by the implementer. Settle by building two apps in one process and fetching the public page from the second.
- source_spec: spec-9-2-anonymous-graphql-rate-limit.md
  summary: The AGENTS.md "anonymous surface is bounded" bullet now carries a `/graphql`-specific parenthetical inside a list of bounds every new public route inherits. Move it into its own sentence after the list, so it does not read as a rule for every route.
  evidence: Story 9.2 Review Triage Log #15; routed defer because the fix edits an agent-context file.
