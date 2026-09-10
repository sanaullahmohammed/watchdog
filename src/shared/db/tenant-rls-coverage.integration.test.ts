import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import sql from '@/shared/db/postgres';

/**
 * Structural guard, rather than a test of one table's behaviour.
 *
 * Any table carrying `org_id` is tenant-scoped by definition, so it must have
 * row level security enabled, forced, and at least one policy. This catches the
 * failure that behavioural tests never will: table fifteen ships with the
 * column and without the policy, and nothing complains until it leaks.
 *
 * See ARCHITECTURE.md section 6.3 and DOMAIN.md's policy sketch.
 */

type TenantTable = {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
};

async function tenantScopedTables(): Promise<TenantTable[]> {
  return sql<TenantTable[]>`
    select
      c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced,
      (select count(*) from pg_policy p where p.polrelid = c.oid)::int
        as policy_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a
      on a.attrelid = c.oid
      and a.attname = 'org_id'
      and a.attnum > 0
      and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by c.relname
  `;
}

describe('RLS coverage across tenant-scoped tables', () => {
  after(async () => {
    await sql.end({ timeout: 5 });
  });

  it('finds at least one tenant-scoped table', async () => {
    // Guards the guard: if the catalogue query silently stops matching, every
    // assertion below would pass over an empty list.
    const tables = await tenantScopedTables();
    assert.ok(
      tables.length > 0,
      'no tables with an org_id column were found; the catalogue query is wrong',
    );
  });

  it('enables and forces row level security on every one of them', async () => {
    const tables = await tenantScopedTables();

    const missing = tables.filter(
      (t) => !t.rls_enabled || !t.rls_forced || t.policy_count < 1,
    );

    assert.deepEqual(
      missing.map((t) => ({
        table: t.table_name,
        rls_enabled: t.rls_enabled,
        rls_forced: t.rls_forced,
        policies: t.policy_count,
      })),
      [],
      'every table carrying org_id needs RLS enabled, FORCEd, and at least one policy',
    );
  });
});
