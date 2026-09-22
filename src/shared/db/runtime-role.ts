import type { Sql } from 'postgres';

/**
 * The boot guard on the database role. Row-level security is WatchDog's tenant
 * boundary, and no repository adds an `org_id` predicate of its own. A role
 * that is a superuser, or has BYPASSRLS, is exempt from every policy, so an
 * api connected as one would serve every tenant's rows to anyone who asked:
 * `/status/:orgSlug` included, with no session at all.
 *
 * In Compose the owner role is the superuser, and its URL sits one line from
 * DATABASE_URL in `.env.example`. The check that the runtime role is safe
 * lived only in an integration test, so nothing stopped a deployment that
 * swapped the two (Epic 3 retrospective, R-14). `api` and `worker` now run
 * this before they serve or do any work, and refuse to start.
 */

export type DatabaseRole = {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

export class UnsafeDatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabaseRoleError';
  }
}

/** Why a role must not run the application, or undefined when it may. */
export function roleRefusal(role: DatabaseRole): string | undefined {
  const exemptions = [
    role.rolsuper && 'a superuser',
    role.rolbypassrls && 'has BYPASSRLS',
  ].filter(Boolean);

  if (exemptions.length === 0) {
    return undefined;
  }

  return (
    `DATABASE_URL connects as "${role.rolname}", which ${
      role.rolsuper ? 'is ' : ''
    }${exemptions.join(' and ')}, so row-level security would not apply and ` +
    "every organization's rows would be visible to every request. Point " +
    'DATABASE_URL at the application role, watchdog_app.'
  );
}

/**
 * Refuses to continue unless the connection's role is bound by RLS. The
 * connection is passed in rather than imported, so the rule above stays free
 * of configuration and its unit test needs no database.
 */
export async function assertTenantBoundRole(connection: Sql) {
  const [role] = await connection<DatabaseRole[]>`
    select rolname, rolsuper, rolbypassrls
    from pg_roles
    where rolname = current_user
  `;

  const refusal = roleRefusal(role);
  if (refusal) {
    throw new UnsafeDatabaseRoleError(refusal);
  }
}
