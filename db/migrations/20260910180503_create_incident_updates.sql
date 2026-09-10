-- migrate:up
-- The incident timeline. Append-only, and enforced as such rather than merely
-- intended: the repository simply not exposing an update method would leave
-- anything holding a tenant transaction free to rewrite history.
create table incident_updates (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  incident_id uuid not null,
  -- The status the incident held when this was written, so the timeline reads
  -- correctly even after the incident moves on.
  status text not null,
  message text not null,
  created_by_user_id text references "user" ("id") on delete set null,
  created_at timestamptz not null default now(),

  constraint incident_updates_status_ck check (
    status in ('draft', 'investigating', 'identified', 'monitoring', 'resolved')
  ),

  constraint incident_updates_incident_fkey
    foreign key (incident_id, org_id)
    references incidents (id, org_id) on delete cascade
);

-- (created_at, id) is the timeline order: id breaks ties for updates written
-- inside one transaction, which share a timestamp.
create index incident_updates_timeline_idx
  on incident_updates (incident_id, created_at, id);
create index incident_updates_org_id_idx on incident_updates (org_id);

alter table incident_updates enable row level security;
alter table incident_updates force row level security;

-- Separate policies per command rather than one covering everything, so the
-- absence of UPDATE and DELETE policies is visible in the schema.
create policy incident_updates_org_select
on incident_updates for select
using (org_id = current_setting('app.current_org_id', true));

create policy incident_updates_org_insert
on incident_updates for insert
with check (org_id = current_setting('app.current_org_id', true));

-- The policies above would make an UPDATE match no rows, which is a silent
-- no-op. Revoking the privilege makes it a loud permission error instead.
-- ALTER DEFAULT PRIVILEGES granted these at creation; this revoke is one-time
-- and is not undone by later grants to other tables.
revoke update, delete on incident_updates from watchdog_app;

-- migrate:down
drop table if exists incident_updates;
