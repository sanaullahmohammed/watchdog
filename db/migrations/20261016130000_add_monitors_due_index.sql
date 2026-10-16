-- migrate:up
-- The due query (Story 5.8) filters one organization's enabled monitors and
-- compares last_checked_at with the interval. A coarse filter: the interval
-- arithmetic is per row. Promised by 20261009120000_create_monitors.sql.
create index monitors_due_idx on monitors (org_id, last_checked_at)
  where enabled;

-- migrate:down
drop index if exists monitors_due_idx;
