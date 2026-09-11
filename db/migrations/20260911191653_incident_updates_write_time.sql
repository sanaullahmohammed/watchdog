-- migrate:up
-- Timeline entries are ordered by created_at. `now()` is the time the
-- transaction started, not the time the row was written. So an entry from a
-- transaction that waited on the incident's row lock could sort before an entry
-- written earlier by the transaction it was waiting for, and the timeline would
-- appear to move backwards. clock_timestamp() is the time the row is written.
-- Once the row is locked, that is the order the writes actually happened in.
-- Epic 2 retrospective, R-3.
alter table incident_updates alter column created_at set default clock_timestamp();

-- migrate:down
alter table incident_updates alter column created_at set default now();
