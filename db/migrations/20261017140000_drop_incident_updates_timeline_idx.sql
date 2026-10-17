-- migrate:up
-- Both timelines (stories 5.13 and 5.14) order by sequence and are served by
-- incident_updates_sequence_idx, so no read uses this index any more.
drop index if exists incident_updates_timeline_idx;

-- migrate:down
create index incident_updates_timeline_idx
  on incident_updates (incident_id, created_at, id);
