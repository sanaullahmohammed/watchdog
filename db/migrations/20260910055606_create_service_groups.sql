-- migrate:up
-- First tenant-scoped table. Establishes the pattern every other WatchDog
-- table follows: org_id text referencing Better Auth's "organization", RLS
-- enabled AND forced, one policy covering both USING and WITH CHECK.
-- See DOMAIN.md (ServiceGroup, tenant-scoped RLS policy sketch).
create table service_groups (
  id uuid primary key default gen_random_uuid(),
  -- text, not uuid: Better Auth ids are 32-char alphanumeric strings, which is
  -- also why the policies below need no ::uuid cast.
  org_id text not null references "organization" ("id") on delete cascade,
  name text not null,
  slug text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_groups_org_slug_uk unique (org_id, slug)
);

create index service_groups_org_id_idx on service_groups (org_id);

alter table service_groups enable row level security;
-- FORCE matters: without it the table owner is exempt, and watchdog_owner runs
-- the migrations. It does not help against a superuser, which is why the
-- application connects as watchdog_app (nosuperuser, nobypassrls).
alter table service_groups force row level security;

-- current_setting(..., true) yields NULL only on a connection that has never
-- set the GUC; once any transaction has, it reverts to the setting's reset
-- value, which for a custom GUC is the empty string. `org_id = NULL` is NULL
-- and `org_id = ''` is false, so both match no rows and the policy fails closed
-- either way. Never write a policy that treats unset as unrestricted: no
-- `is null` branch, no `coalesce` over the GUC.
create policy service_groups_org_isolation
on service_groups
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- migrate:down
drop table if exists service_groups;
