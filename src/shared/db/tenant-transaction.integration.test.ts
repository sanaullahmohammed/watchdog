import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sql from '@/shared/db/postgres';
import {
  InvalidOrganizationIdError,
  withTenantTransaction,
} from '@/shared/db/tenant-transaction';

/**
 * Tenant isolation is the invariant every other WatchDog story leans on, so it
 * is proven against a real database rather than asserted in prose.
 *
 * These run against the connection in DATABASE_URL, which must be watchdog_app:
 * a role that is neither superuser nor BYPASSRLS. Running them as the owner
 * would prove nothing, which is what the first test guards against.
 *
 * Requires a migrated database. See ARCHITECTURE.md section 6 and DOMAIN.md's
 * GUC contract.
 */

/** Mirrors Better Auth's default generator: 32 alphanumeric characters. */
function betterAuthId(): string {
  return randomBytes(24)
    .toString('base64url')
    .replace(/[_-]/g, 'a')
    .slice(0, 32);
}

const orgA = betterAuthId();
const orgB = betterAuthId();

async function createOrganization(id: string, slug: string) {
  await sql`
    insert into "organization" ("id", "name", "slug", "createdAt")
    values (${id}, ${`Org ${slug}`}, ${slug}, now())
  `;
}

async function countGroupsFor(orgId: string): Promise<number> {
  return withTenantTransaction(orgId, async ({ sql: tx }) => {
    const rows = await tx<{ count: string }[]>`
      select count(*)::text as count from service_groups
    `;
    return Number(rows[0].count);
  });
}

describe('tenant isolation on service_groups', () => {
  before(async () => {
    await createOrganization(orgA, `rls-a-${orgA.slice(0, 8)}`);
    await createOrganization(orgB, `rls-b-${orgB.slice(0, 8)}`);

    for (const [orgId, names] of [
      [orgA, ['a-one', 'a-two']],
      [orgB, ['b-one']],
    ] as const) {
      await withTenantTransaction(orgId, async ({ sql: tx }) => {
        for (const name of names) {
          await tx`
            insert into service_groups (org_id, name, slug)
            values (${orgId}, ${name}, ${name})
          `;
        }
      });
    }
  });

  after(async () => {
    for (const orgId of [orgA, orgB]) {
      await withTenantTransaction(orgId, async ({ sql: tx }) => {
        await tx`delete from service_groups`;
      });
    }
    await sql`delete from "organization" where "id" in (${orgA}, ${orgB})`;
    await sql.end({ timeout: 5 });
  });

  it('runs as a role that cannot bypass RLS', async () => {
    const [role] = await sql<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      select current_user, r.rolsuper, r.rolbypassrls
      from pg_roles r
      where r.rolname = current_user
    `;

    assert.equal(
      role.rolsuper,
      false,
      `connected as superuser "${role.current_user}"; a superuser bypasses RLS and these tests would prove nothing`,
    );
    assert.equal(role.rolbypassrls, false);
  });

  it('shows each organization only its own rows', async () => {
    assert.equal(await countGroupsFor(orgA), 2);
    assert.equal(await countGroupsFor(orgB), 1);
  });

  it('hides another organization rows even when the id is known', async () => {
    const idFromA = await withTenantTransaction(orgA, async ({ sql: tx }) => {
      const rows = await tx<{ id: string }[]>`
        select id from service_groups where slug = 'a-one'
      `;
      return rows[0].id;
    });

    const seenByB = await withTenantTransaction(orgB, async ({ sql: tx }) => {
      return tx<{ id: string }[]>`
        select id from service_groups where id = ${idFromA}
      `;
    });

    assert.equal(seenByB.length, 0);
  });

  it('does not let one organization update another rows', async () => {
    const updated = await withTenantTransaction(orgB, async ({ sql: tx }) => {
      const rows = await tx`
        update service_groups set name = 'hijacked' where slug = 'a-one'
        returning id
      `;
      return rows.length;
    });

    assert.equal(updated, 0);

    const stillIntact = await withTenantTransaction(
      orgA,
      async ({ sql: tx }) => {
        const rows = await tx<{ name: string }[]>`
        select name from service_groups where slug = 'a-one'
      `;
        return rows[0].name;
      },
    );

    assert.equal(stillIntact, 'a-one');
  });

  it('does not let one organization delete another rows', async () => {
    const deleted = await withTenantTransaction(orgB, async ({ sql: tx }) => {
      const rows = await tx`
        delete from service_groups where slug = 'a-one' returning id
      `;
      return rows.length;
    });

    assert.equal(deleted, 0);
    assert.equal(await countGroupsFor(orgA), 2);
  });

  it('rejects writing a row scoped to a different organization', async () => {
    await assert.rejects(
      withTenantTransaction(orgB, async ({ sql: tx }) => {
        await tx`
          insert into service_groups (org_id, name, slug)
          values (${orgA}, 'smuggled', 'smuggled')
        `;
      }),
      /row-level security/i,
      'WITH CHECK should refuse a row whose org_id differs from the GUC',
    );

    assert.equal(await countGroupsFor(orgA), 2);
  });

  it('returns no rows when the GUC is unset, rather than every row', async () => {
    // Outside a tenant transaction there is no SET LOCAL, so current_setting
    // yields NULL and `org_id = NULL` filters everything. Fails closed.
    const rows = await sql`select id from service_groups`;
    assert.equal(rows.length, 0);
  });

  it('does not leak the GUC past the transaction that set it', async () => {
    await countGroupsFor(orgA);

    // Reverts to the GUC's reset value, which for a custom setting never given
    // a global value is the empty string rather than NULL. NULL only appears on
    // a connection that has never set it at all, so this is connection-state
    // dependent. Both fail closed - `org_id = ''` is false, `org_id = NULL` is
    // NULL - but a policy must never treat "unset" as "see everything".
    const [{ value }] = await sql<{ value: string | null }[]>`
      select current_setting('app.current_org_id', true) as value
    `;

    assert.ok(
      value === null || value === '',
      `expected the GUC to be cleared, got ${JSON.stringify(value)}`,
    );

    // The property that actually matters: a pooled connection that has just
    // served a tenant transaction shows nothing to an unscoped query.
    const rows = await sql`select id from service_groups`;
    assert.equal(rows.length, 0);
  });

  it('does not bleed one organization scope into the next on a pooled connection', async () => {
    // postgres.js reuses connections, so consecutive tenant transactions can
    // land on the same backend. Each must see only its own rows.
    for (const [orgId, expected] of [
      [orgA, 2],
      [orgB, 1],
      [orgA, 2],
      [orgB, 1],
    ] as const) {
      assert.equal(await countGroupsFor(orgId), expected);
    }
  });

  it('rejects a malformed organization id before opening a transaction', async () => {
    for (const bad of ['', "' or true --", 'has space', 'a'.repeat(256)]) {
      await assert.rejects(
        withTenantTransaction(bad, async () => undefined),
        InvalidOrganizationIdError,
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
  });
});
