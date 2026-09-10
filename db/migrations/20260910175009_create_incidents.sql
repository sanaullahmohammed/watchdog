-- migrate:up
-- Incidents and their per-service impact. See DOMAIN.md (Incident,
-- IncidentServiceImpact) and Story 2.8.

-- Referenced by incident_service_impacts through a tenant-scoped key, so
-- services needs (id, org_id) unique the same way service_groups does.
alter table services
  add constraint services_id_org_uk unique (id, org_id);

create table incidents (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  title text not null,
  status text not null,
  impact text not null,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Better Auth's "user" is not tenant-scoped, so this is a plain reference.
  -- Null for system-created incidents, which have no human author.
  created_by_user_id text references "user" ("id") on delete set null,
  -- The monitor that produced a draft. The foreign key to `monitors` arrives
  -- with that table in Epic 5, and will be composite like every other
  -- tenant-scoped key. The column and the index below do not need it.
  origin_monitor_id uuid,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint incidents_status_ck check (
    status in ('draft', 'investigating', 'identified', 'monitoring', 'resolved')
  ),
  constraint incidents_impact_ck check (
    impact in ('none', 'minor', 'major', 'critical')
  ),
  constraint incidents_source_ck check (
    source in ('manual', 'monitoring', 'ai_assisted')
  ),
  constraint incidents_id_org_uk unique (id, org_id)
);

create index incidents_org_id_idx on incidents (org_id);
create index incidents_status_idx on incidents (org_id, status);

-- DOMAIN.md's authoritative guard against two open drafts for one monitor.
-- Partial, so a monitor may have many resolved incidents but only one draft.
create unique index incidents_monitor_draft_uk
  on incidents (org_id, origin_monitor_id)
  where status = 'draft';

alter table incidents enable row level security;
alter table incidents force row level security;

create policy incidents_org_isolation
on incidents
using (org_id = current_setting('app.current_org_id', true))
with check (org_id = current_setting('app.current_org_id', true));

-- Join table. Carries org_id directly rather than reaching it through a join,
-- so RLS applies to it as a table in its own right.
create table incident_service_impacts (
  org_id text not null references "organization" ("id") on delete cascade,
  incident_id uuid not null,
  service_id uuid not null,
  impact text not null,
  created_at timestamptz not null default now(),

  primary key (incident_id, service_id),

  constraint incident_service_impacts_impact_ck check (
    impact in ('none', 'minor', 'major', 'critical')
  ),

  -- Both keys span org_id: referential integrity checks run with row security
  -- disabled, so a single-column key would let one organization attach
  -- another's service to its incident. See DOMAIN.md, Tenant-scoped foreign keys.
  constraint incident_service_impacts_incident_fkey
    foreign key (incident_id, org_id)
    references incidents (id, org_id) on delete cascade,

  constraint incident_service_impacts_service_fkey
    foreign key (service_id, org_id)
    references services (id, org_id) on delete cascade
);

create index incident_service_impacts_org_id_idx
  on incident_service_impacts (org_id);
create index incident_service_impacts_service_idx
  on incident_service_impacts (service_id);

alter table incident_service_impacts enable row level security;
alter table incident_service_impacts force row level security;

create policy incident_service_impacts_org_isolation
on incident_service_impacts
using (org_id = current_setting('app.current_org_id', true))
with check (org_id = current_setting('app.current_org_id', true));

-- migrate:down
drop table if exists incident_service_impacts;
drop table if exists incidents;
alter table services drop constraint if exists services_id_org_uk;
