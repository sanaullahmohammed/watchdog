-- migrate:up
-- Which failure episode of the origin monitor proposed this draft. Null for
-- declared incidents. With the origin monitor it makes a repeated proposal for
-- one episode a no-op (incidents_monitor_episode_uk below).
alter table incidents add column origin_failure_episode integer;

-- Rows written before monitors existed (test inserts with made-up ids) name
-- no monitor, so the foreign key below would refuse them. This runs as the
-- owner, a superuser in Compose and CI as 20261017130000 notes, so FORCEd RLS
-- does not hide rows.
update incidents i set origin_monitor_id = null
where origin_monitor_id is not null
  and not exists (
    select 1 from monitors m
    where m.id = i.origin_monitor_id and m.org_id = i.org_id
  );

-- Composite like every tenant-scoped key. Set-null on the monitor column only,
-- so org_id (not null) is never nulled. There is no CHECK pairing the two
-- columns: set-null would violate it. An episode left beside a null monitor is
-- harmless, because null monitor ids never collide in the index.
alter table incidents
  add constraint incidents_origin_monitor_fkey
  foreign key (origin_monitor_id, org_id) references monitors (id, org_id)
  on delete set null (origin_monitor_id);

-- DOMAIN: one proposal per monitor per failure episode, whatever became of it.
create unique index incidents_monitor_episode_uk
  on incidents (org_id, origin_monitor_id, origin_failure_episode)
  where origin_failure_episode is not null;

-- migrate:down
-- Ids nulled by up are not restored.
drop index if exists incidents_monitor_episode_uk;
alter table incidents drop constraint if exists incidents_origin_monitor_fkey;
alter table incidents drop column if exists origin_failure_episode;
