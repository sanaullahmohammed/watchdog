-- migrate:up
-- The service catalog. Follows the tenant-table pattern established by
-- service_groups: org_id text referencing Better Auth's "organization", RLS
-- enabled AND forced, one policy covering USING and WITH CHECK.
-- See DOMAIN.md (Service entity) and Story 2.2.
create table services (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  -- service_groups already exists from the tenant-isolation work; this is a
  -- reference to it, not a second definition of it.
  -- SET NULL rather than CASCADE: deleting a group ungroups its services
  -- rather than destroying them. See Story 2.3.
  service_group_id uuid references service_groups (id) on delete set null,
  name text not null,
  slug text not null,
  description text,
  manual_status_override text,
  is_public boolean not null default true,
  display_order integer not null default 0,
  archived_at timestamptz,
  -- Derived, written only by the status recomputation handler. Held because a
  -- pure function has no previous value to diff against, and because the public
  -- read model would otherwise recompute across incidents, maintenance and
  -- monitor results on every request. See DOMAIN.md, Status recomputation.
  last_known_status text not null default 'operational',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Uniqueness spans archived services, so archiving reserves a slug
  -- permanently. Chosen deliberately over a partial index on
  -- `archived_at is null`; the reasoning is in DOMAIN.md.
  constraint services_org_slug_uk unique (org_id, slug),

  constraint services_manual_status_override_ck check (
    manual_status_override is null
    or manual_status_override in (
      'operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'
    )
  ),
  constraint services_last_known_status_ck check (
    last_known_status in (
      'operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'
    )
  )
);

create index services_org_id_idx on services (org_id);
create index services_service_group_id_idx on services (service_group_id);

alter table services enable row level security;
alter table services force row level security;

create policy services_org_isolation
on services
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- migrate:down
drop table if exists services;
