-- migrate:up
-- Scheduled maintenance windows. See DOMAIN.md (Maintenance) and Story 2.12.
create table maintenance (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  title text not null,
  description text,
  status text not null default 'scheduled',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_by_user_id text references "user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint maintenance_status_ck check (
    status in ('scheduled', 'in_progress', 'completed')
  ),
  -- A window that ends before it starts is not a window. Enforced here rather
  -- than only in a handler, so it holds for the worker and any seed too.
  constraint maintenance_window_ck check (scheduled_end_at > scheduled_start_at),

  constraint maintenance_id_org_uk unique (id, org_id)
);

create index maintenance_org_id_idx on maintenance (org_id);
-- The worker's due-window scan reads by status and time.
create index maintenance_due_idx
  on maintenance (status, scheduled_start_at, scheduled_end_at);

alter table maintenance enable row level security;
alter table maintenance force row level security;

create policy maintenance_org_isolation
on maintenance
using (org_id = current_setting('app.current_org_id', true))
with check (org_id = current_setting('app.current_org_id', true));

create table maintenance_services (
  org_id text not null references "organization" ("id") on delete cascade,
  maintenance_id uuid not null,
  service_id uuid not null,
  created_at timestamptz not null default now(),

  primary key (maintenance_id, service_id),

  -- Both keys span org_id; referential integrity checks ignore RLS.
  constraint maintenance_services_maintenance_fkey
    foreign key (maintenance_id, org_id)
    references maintenance (id, org_id) on delete cascade,

  constraint maintenance_services_service_fkey
    foreign key (service_id, org_id)
    references services (id, org_id) on delete cascade
);

create index maintenance_services_org_id_idx on maintenance_services (org_id);
create index maintenance_services_service_idx on maintenance_services (service_id);

alter table maintenance_services enable row level security;
alter table maintenance_services force row level security;

create policy maintenance_services_org_isolation
on maintenance_services
using (org_id = current_setting('app.current_org_id', true))
with check (org_id = current_setting('app.current_org_id', true));

-- migrate:down
drop table if exists maintenance_services;
drop table if exists maintenance;
