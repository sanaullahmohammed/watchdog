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

type TenantForeignKey = {
  constraint_name: string;
  from_table: string;
  to_table: string;
  from_columns: string[];
};

/**
 * Foreign keys between tenant tables, and the columns they constrain.
 *
 * Referential integrity checks run with row security disabled, so a foreign key
 * that omits org_id lets a tenant point at a row it cannot read. See DOMAIN.md,
 * Tenant-scoped foreign keys.
 */
async function tenantForeignKeys(): Promise<TenantForeignKey[]> {
  return sql<TenantForeignKey[]>`
    select
      con.conname as constraint_name,
      src.relname as from_table,
      tgt.relname as to_table,
      (
        select array_agg(att.attname order by keys.ord)
        from unnest(con.conkey) with ordinality as keys(attnum, ord)
        join pg_attribute att
          on att.attrelid = con.conrelid and att.attnum = keys.attnum
      ) as from_columns
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    where con.contype = 'f'
      and n.nspname = 'public'
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = src.oid and a.attname = 'org_id'
          and a.attnum > 0 and not a.attisdropped
      )
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = tgt.oid and a.attname = 'org_id'
          and a.attnum > 0 and not a.attisdropped
      )
    order by con.conname
  `;
}

describe('tenant-scoped foreign keys', () => {
  it('includes org_id in every foreign key between two tenant tables', async () => {
    const keys = await tenantForeignKeys();

    const unscoped = keys
      .filter((key) => !key.from_columns.includes('org_id'))
      .map((key) => ({
        constraint: key.constraint_name,
        from: `${key.from_table} (${key.from_columns.join(', ')})`,
        to: key.to_table,
      }));

    assert.deepEqual(
      unscoped,
      [],
      'RLS does not protect foreign keys; a key between two tenant tables must span org_id',
    );
  });
});

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
