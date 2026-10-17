-- migrate:up
-- The timeline order is a sequence Postgres assigns at insert, not the clock.
-- created_at can step back (Epic 2 D-1), so (created_at, id) could sort a
-- later entry first. Writers lock the incident before inserting, and nextval is
-- taken at insert, so the number follows the lock.
-- This migration holds ACCESS EXCLUSIVE on incident_updates while it rewrites
-- every row.
alter table incident_updates add column sequence bigint;

-- Existing rows keep their current (created_at, id) order. This runs as the
-- owner, a superuser in Compose and CI, so FORCEd RLS does not hide rows. A
-- non-bypass owner would leave nulls and set not null below would fail loudly.
update incident_updates u set sequence = o.n
from (
  select id, row_number() over (order by created_at, id) as n
  from incident_updates
) o
where u.id = o.id;

alter table incident_updates alter column sequence set not null;

-- The identity keeps the default CACHE 1, which is what makes numbers follow
-- insert order across connections. Do not raise it.
alter table incident_updates
  alter column sequence add generated always as identity;

select setval(
  pg_get_serial_sequence('incident_updates', 'sequence'),
  coalesce(max(sequence), 0) + 1,
  false
) from incident_updates;

create unique index incident_updates_sequence_idx
  on incident_updates (incident_id, sequence);

-- GENERATED ALWAYS refuses a plain explicit value, but any role with table
-- INSERT can still say OVERRIDING SYSTEM VALUE. Grant insert on every column
-- except sequence so watchdog_app cannot choose a value. A future column on
-- this table needs its own insert grant in its migration.
revoke insert on incident_updates from watchdog_app;
grant insert (id, org_id, incident_id, status, message, created_by_user_id, created_at)
  on incident_updates to watchdog_app;

-- An identity's implicit nextval needs no sequence privilege, so withhold it:
-- otherwise tenant code could read the global last_value or burn numbers.
revoke usage, select on sequence incident_updates_sequence_seq from watchdog_app;

-- migrate:down
grant usage, select on sequence incident_updates_sequence_seq to watchdog_app;
revoke insert (id, org_id, incident_id, status, message, created_by_user_id, created_at)
  on incident_updates from watchdog_app;
grant insert on incident_updates to watchdog_app;
alter table incident_updates drop column if exists sequence;
