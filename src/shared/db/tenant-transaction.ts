import type { Sql } from 'postgres';
import sql from '@/shared/db/postgres';

/**
 * Tenant scoping for every repository operation.
 *
 * `SET LOCAL` is transaction-scoped, so tenant-scoped SQL must run inside a
 * transaction or the GUC is simply absent. That failure is silent but safe:
 * `current_setting(..., true)` yields NULL when unset, and `org_id = NULL` is
 * NULL, so an unscoped query returns no rows rather than every row.
 *
 * See ARCHITECTURE.md section 6 and DOMAIN.md's GUC contract.
 */
export const CURRENT_ORG_GUC = 'app.current_org_id';

/**
 * Better Auth generates 32-character alphanumeric ids by default, and can be
 * configured to emit UUIDs instead. Hyphen and underscore are allowed so that
 * switching `advanced.database.generateId` does not silently start rejecting
 * every request. Deliberately not a UUID regex; see ARCHITECTURE.md section 3.
 */
const BETTER_AUTH_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export class InvalidOrganizationIdError extends Error {
  constructor(orgId: unknown) {
    super(
      `Resolved organization id is not a valid Better Auth id: ${JSON.stringify(orgId)}`,
    );
    this.name = 'InvalidOrganizationIdError';
  }
}

export function assertValidBetterAuthOrgId(
  orgId: unknown,
): asserts orgId is string {
  if (typeof orgId !== 'string' || !BETTER_AUTH_ID_PATTERN.test(orgId)) {
    throw new InvalidOrganizationIdError(orgId);
  }
}

/**
 * The transaction handle handed to repositories.
 *
 * Typed as `Sql` rather than postgres.js's `TransactionSql`, which is declared
 * as `Omit<Sql, ...>`; `Omit` maps over properties and so drops the tagged
 * template call signature, leaving `tx\`select ...\`` untyped even though it
 * works at runtime. Absorbing the cast here keeps every repository free of it
 * and preserves the `sql<Row[]>\`...\`` generic form.
 *
 * The trade-off: `begin`, `listen` and `end` appear available on this type but
 * must not be used inside a tenant transaction. Nesting belongs in
 * `savepoint`, and listening belongs on a connection of its own.
 */
export type TenantTransaction = {
  sql: Sql;
  orgId: string;
};

/**
 * Runs `work` inside a transaction scoped to `orgId`.
 *
 * The id is validated before the transaction opens so that a resolution bug
 * fails loudly here rather than surfacing downstream as an inexplicably empty
 * tenant. Handlers must never take the organization from user input; it comes
 * from the request context.
 */
export async function withTenantTransaction<T>(
  orgId: string,
  work: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertValidBetterAuthOrgId(orgId);

  return sql.begin(async (tx) => {
    const scoped = tx as unknown as Sql;
    await scoped`select set_config(${CURRENT_ORG_GUC}, ${orgId}, true)`;
    return work({ sql: scoped, orgId });
  }) as Promise<T>;
}
