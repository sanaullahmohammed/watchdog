-- migrate:up
-- Daily uptime rollups and the per-organization watermark that lets a refresh
-- catch up on closed days before retention drops their raw results. DOMAIN.md
-- (UptimeRollup, UptimeRollupProgress, Which days a refresh covers),
-- ARCHITECTURE.md 6.1, Story 5.11.
create table uptime_rollups (
  org_id text not null references "organization" ("id") on delete cascade,
  service_id uuid not null,
  day date not null,
  total_checks integer not null,
  successful_checks integer not null,
  failed_checks integer not null,
  uptime_ratio numeric(6,5) not null,
  avg_latency_ms numeric,
  worst_status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (org_id, service_id, day),

  constraint uptime_rollups_service_fkey
    foreign key (service_id, org_id)
    references services (id, org_id)
    on delete cascade,
  constraint uptime_rollups_worst_status_ck
    check (worst_status in ('operational', 'degraded', 'major_outage'))
);

alter table uptime_rollups enable row level security;
alter table uptime_rollups force row level security;

create policy uptime_rollups_org_isolation
on uptime_rollups
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

create table uptime_rollup_progress (
  org_id text primary key references "organization" ("id") on delete cascade,
  refreshed_through date not null,
  updated_at timestamptz not null default now()
);

alter table uptime_rollup_progress enable row level security;
alter table uptime_rollup_progress force row level security;

create policy uptime_rollup_progress_org_isolation
on uptime_rollup_progress
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- The first day (UTC) of the oldest check_results partition, or null when
-- there is none. The catalog is the only record of what retention has left,
-- and the application role cannot be handed catalog reads in module SQL, so
-- this is one more owner function (ARCHITECTURE.md 6.1). Names are matched
-- against a strict pattern before they are parsed.
create function public.check_results_retained_from()
returns date
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
as $$
  select min(
    case
      when c.relname::text ~ '^check_results_[0-9]{4}_(0[1-9]|1[0-2])$'
      then make_date(
        substr(c.relname::text, 15, 4)::integer,
        substr(c.relname::text, 20, 2)::integer,
        1
      )
    end
  )
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.check_results'::regclass
$$;

revoke execute on function public.check_results_retained_from() from public;
grant execute on function public.check_results_retained_from() to watchdog_app;

-- migrate:down
drop function if exists public.check_results_retained_from();
drop table if exists uptime_rollup_progress;
drop table if exists uptime_rollups;
