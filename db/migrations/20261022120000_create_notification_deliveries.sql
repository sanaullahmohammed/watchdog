-- migrate:up
-- The delivery ledger and the notification pass's cursor. DOMAIN.md
-- (NotificationDelivery, NotificationCursor), ARCHITECTURE.md 5.6, Story 6.6.
create table notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  subscriber_id uuid not null,
  source_type text not null,
  -- The incident_updates.id, or the maintenance.id for a maintenance source.
  -- No foreign key: a window deleted before send is dropped by the sender
  -- (story 6.7), not cascaded away here.
  source_id uuid not null,
  status text not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- Truncated SMTP or transport diagnostic. Never contains the address.
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,

  -- Tenant-aware, like every cross-table key: a delivery cannot name another
  -- organization's subscriber. Deleting the subscriber deletes its ledger.
  constraint notification_deliveries_subscriber_fkey
    foreign key (subscriber_id, org_id)
    references subscribers (id, org_id) on delete cascade,
  constraint notification_deliveries_source_type_ck check (
    source_type in (
      'incident_update',
      'maintenance_scheduled',
      'maintenance_started',
      'maintenance_completed'
    )
  ),
  constraint notification_deliveries_status_ck
    check (status in ('pending', 'sent', 'failed', 'abandoned')),
  constraint notification_deliveries_attempts_ck check (attempts >= 0)
);

-- One email per subscriber per change: a pass that repeats work, or re-reads
-- its cursor's overlap, inserts nothing new.
create unique index notification_deliveries_once_uk
on notification_deliveries (subscriber_id, source_type, source_id);

-- What the sender (story 6.7) claims: an organization's due pending rows.
create index notification_deliveries_due_idx
on notification_deliveries (org_id, next_attempt_at)
where status = 'pending';

alter table notification_deliveries enable row level security;
alter table notification_deliveries force row level security;

create policy notification_deliveries_org_isolation
on notification_deliveries
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

create table notification_cursors (
  org_id text primary key references "organization" ("id") on delete cascade,
  -- The highest incident_updates.sequence read; 0 before the first pass.
  incident_update_sequence bigint not null default 0,
  -- The latest maintenance created_at, started_at or completed_at read.
  maintenance_read_at timestamptz,
  -- When the last pass read; the overlap is measured back from it.
  read_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table notification_cursors enable row level security;
alter table notification_cursors force row level security;

create policy notification_cursors_org_isolation
on notification_cursors
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- The pass reads an organization's entries by `sequence > cursor or
-- created_at >= read_at - overlap`. Without an index for each branch, the
-- `or` scans the whole table.
create index incident_updates_org_sequence_idx
on incident_updates (org_id, sequence);
create index incident_updates_org_created_at_idx
on incident_updates (org_id, created_at);
-- (org_id, sequence) leads with org_id, so the single-column index from
-- 20260910180503_create_incident_updates.sql is redundant.
drop index if exists incident_updates_org_id_idx;

-- migrate:down
create index incident_updates_org_id_idx on incident_updates (org_id);
drop index if exists incident_updates_org_created_at_idx;
drop index if exists incident_updates_org_sequence_idx;
drop table if exists notification_cursors;
drop table if exists notification_deliveries;
