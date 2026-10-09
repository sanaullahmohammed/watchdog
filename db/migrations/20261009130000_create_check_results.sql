-- migrate:up
-- Append-only monitor results, range-partitioned by month on checked_at.
-- DOMAIN.md (CheckResult, check_results partitioning strategy), ARCHITECTURE.md
-- 6.1 (partition maintenance without owner credentials), Story 5.3.
create table check_results (
  id uuid not null default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  monitor_id uuid not null,
  service_id uuid not null,
  checked_at timestamptz not null,
  status text not null,
  latency_ms integer,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  primary key (id, checked_at),

  constraint check_results_monitor_fkey
    foreign key (monitor_id, org_id)
    references monitors (id, org_id)
    on delete cascade,
  constraint check_results_service_fkey
    foreign key (service_id, org_id)
    references services (id, org_id)
    on delete cascade,
  constraint check_results_status_ck check (status in ('success', 'failure'))
) partition by range (checked_at);

-- Created on the parent; each partition gets its own copy.
create index check_results_org_service_checked_at_idx
on check_results (org_id, service_id, checked_at desc);

create index check_results_org_monitor_checked_at_idx
on check_results (org_id, monitor_id, checked_at desc);

create index check_results_failure_idx
on check_results (org_id, monitor_id, checked_at desc)
where status = 'failure';

alter table check_results enable row level security;
alter table check_results force row level security;

create policy check_results_org_isolation
on check_results
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- Append-only, enforced. See create_incident_updates for why a revoke rather
-- than an absent policy.
revoke update, delete on check_results from watchdog_app;

-- Serializes partition maintenance across workers. A plain advisory lock wait
-- would fall under the callers' lock_timeout, and the table-lock helper below
-- can legitimately hold the key for several seconds of retries, so this polls
-- without a timeout of its own. Owner-only, like the helper below.
create function public.lock_check_results_maintenance()
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  for v_attempt in 1..100 loop
    if pg_try_advisory_xact_lock(5300001) then
      return;
    end if;
    perform pg_sleep(0.1);
  end loop;
  raise exception 'could not take the partition maintenance lock'
    using errcode = '55P03';
end;
$$;

revoke execute on function public.lock_check_results_maintenance() from public;

-- Takes every table lock partition DDL needs, without waiting. Creating a
-- partition takes ACCESS EXCLUSIVE on check_results and SHARE ROW EXCLUSIVE on
-- the three tables its foreign keys reference; a writer such as an
-- organization delete cascading into check_results takes them in the other
-- order. Waiting for one while holding another deadlocks, so each attempt asks
-- for all of them with NOWAIT, a refusal releases whatever the attempt got,
-- and the next attempt follows shortly. Dropping a partition needs only the
-- parent. Called only by the two functions below; no grant to watchdog_app.
create function public.lock_check_results_for_ddl(p_for_create boolean)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  for v_attempt in 1..50 loop
    begin
      if p_for_create then
        lock table public."organization", public.services, public.monitors
          in share row exclusive mode nowait;
      end if;
      lock table public.check_results in access exclusive mode nowait;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.1);
    end;
  end loop;
  raise exception 'could not lock check_results for partition maintenance'
    using errcode = '55P03';
end;
$$;

revoke execute on function public.lock_check_results_for_ddl(boolean) from public;

-- Creates the monthly partitions from the earlier of p_from's month and the
-- current month, through the current month + 2. Returns how many it created.
-- Runs as the owner because watchdog_app may not run DDL.
create function public.create_check_result_partitions(p_from date default null)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set lock_timeout = '3s'
as $$
declare
  v_current date := date_trunc('month', now())::date;
  v_start date;
  v_month date;
  v_next date;
  v_name text;
  v_created integer := 0;
  v_locked boolean := false;
begin
  v_start := least(
    coalesce(date_trunc('month', p_from::timestamp)::date, v_current),
    v_current
  );
  if v_start < (v_current - interval '13 months')::date then
    raise exception 'p_from is more than 13 months before the current month'
      using errcode = '22023';
  end if;

  perform public.lock_check_results_maintenance();

  v_month := v_start;
  while v_month <= (v_current + interval '2 months')::date loop
    v_next := (v_month + interval '1 month')::date;
    v_name := 'check_results_' || to_char(v_month, 'YYYY_MM');

    if to_regclass(format('public.%I', v_name)) is null then
      if not v_locked then
        perform public.lock_check_results_for_ddl(true);
        v_locked := true;
      end if;
      execute format(
        'create table public.%I partition of public.check_results for values from (%L) to (%L)',
        v_name,
        make_timestamptz(
          extract(year from v_month)::int, extract(month from v_month)::int,
          1, 0, 0, 0, 'UTC'
        ),
        make_timestamptz(
          extract(year from v_next)::int, extract(month from v_next)::int,
          1, 0, 0, 0, 'UTC'
        )
      );
      execute format(
        'revoke all on table public.%I from public, watchdog_app', v_name
      );
      execute format('alter table public.%I enable row level security', v_name);
      execute format('alter table public.%I force row level security', v_name);
      execute format(
        'create policy %I on public.%I using (org_id = current_setting(%L, true)) with check (org_id = current_setting(%L, true))',
        v_name || '_org_isolation', v_name,
        'app.current_org_id', 'app.current_org_id'
      );
      v_created := v_created + 1;
    end if;

    v_month := v_next;
  end loop;

  return v_created;
end;
$$;

-- Drops each monthly partition whose upper bound is at or before now() minus
-- p_retention_days. Returns how many it dropped. Names come from the catalog,
-- are matched against a strict pattern, and are rebuilt from the parsed year and
-- month, so nothing read is executed as text.
--
-- Dropping an attached partition detaches it and drops it in one statement,
-- under an ACCESS EXCLUSIVE lock on check_results alone. An explicit DETACH
-- first would turn the partition's foreign keys into standalone ones, whose
-- removal then takes ACCESS EXCLUSIVE on "organization", monitors and services
-- and deadlocks against ordinary writers.
create function public.drop_expired_check_result_partitions(p_retention_days integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set lock_timeout = '3s'
as $$
declare
  v_rel record;
  v_year integer;
  v_month integer;
  v_upper timestamptz;
  v_name text;
  v_dropped integer := 0;
  v_locked boolean := false;
begin
  if p_retention_days is null or p_retention_days < 1 then
    raise exception 'p_retention_days must be a positive number of days'
      using errcode = '22023';
  end if;

  perform public.lock_check_results_maintenance();

  for v_rel in
    select c.relname::text as relname
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.check_results'::regclass
      and c.relname::text ~ '^check_results_[0-9]{4}_[0-9]{2}$'
    order by c.relname
  loop
    v_year := substr(v_rel.relname, 15, 4)::integer;
    v_month := substr(v_rel.relname, 20, 2)::integer;
    continue when v_month < 1 or v_month > 12;

    v_name := 'check_results_' || to_char(v_year, 'FM0000') || '_' || to_char(v_month, 'FM00');
    v_upper := make_timestamptz(v_year, v_month, 1, 0, 0, 0, 'UTC') + interval '1 month';

    if v_upper <= now() - make_interval(days => p_retention_days) then
      if not v_locked then
        perform public.lock_check_results_for_ddl(false);
        v_locked := true;
      end if;
      execute format('drop table public.%I', v_name);
      v_dropped := v_dropped + 1;
    end if;
  end loop;

  return v_dropped;
end;
$$;

revoke execute on function public.create_check_result_partitions(date) from public;
grant execute on function public.create_check_result_partitions(date) to watchdog_app;
revoke execute on function public.drop_expired_check_result_partitions(integer) from public;
grant execute on function public.drop_expired_check_result_partitions(integer) to watchdog_app;

-- So inserts work before the first worker pass.
select public.create_check_result_partitions();

-- migrate:down
drop function if exists public.drop_expired_check_result_partitions(integer);
drop function if exists public.create_check_result_partitions(date);
drop function if exists public.lock_check_results_for_ddl(boolean);
drop function if exists public.lock_check_results_maintenance();
drop table if exists check_results;
