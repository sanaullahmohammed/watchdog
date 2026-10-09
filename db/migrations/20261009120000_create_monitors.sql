-- migrate:up
-- Synthetic check configuration. Tenant table: org_id, RLS enabled AND forced,
-- one policy covering USING and WITH CHECK. See DOMAIN.md (Monitor) and
-- Story 5.1.
create table monitors (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  service_id uuid not null,
  type text not null,
  name text not null,
  target text not null,
  interval_seconds integer not null default 60,
  timeout_seconds integer not null default 10,
  enabled boolean not null default true,
  failure_threshold integer not null default 3,
  config jsonb not null default '{}'::jsonb,
  -- Maintained by checks (Story 5.6) and by edits that move derived state.
  consecutive_failures integer not null default 0,
  -- Never reset: re-enabling must not reuse an episode. DOMAIN.md, Monitor.
  failure_episode integer not null default 0,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint monitors_id_org_uk unique (id, org_id),

  -- Tenant foreign key: org_id is part of the key so the database refuses a
  -- reference to another organization's service. DOMAIN.md, Tenant-scoped
  -- foreign keys.
  constraint monitors_service_fkey
    foreign key (service_id, org_id)
    references services (id, org_id)
    on delete cascade,

  constraint monitors_type_ck
    check (type in ('http', 'tcp', 'keyword', 'ssl_expiry')),
  constraint monitors_name_ck check (char_length(name) between 1 and 120),
  constraint monitors_target_ck check (char_length(target) between 1 and 2048),
  constraint monitors_interval_ck
    check (interval_seconds between 30 and 86400),
  constraint monitors_timeout_ck check (timeout_seconds between 1 and 60),
  constraint monitors_timeout_below_interval_ck
    check (timeout_seconds < interval_seconds),
  constraint monitors_failure_threshold_ck
    check (failure_threshold between 1 and 20),
  constraint monitors_consecutive_failures_ck check (consecutive_failures >= 0),
  constraint monitors_failure_episode_ck check (failure_episode >= 0),
  constraint monitors_config_object_ck check (jsonb_typeof(config) = 'object'),
  constraint monitors_warn_days_ck check (
    not (config ? 'warnDays')
    or (
      jsonb_typeof(config -> 'warnDays') = 'number'
      and (config ->> 'warnDays') ~ '^[0-9]+$'
      and (config ->> 'warnDays')::integer between 1 and 365
    )
  ),
  constraint monitors_keyword_ck check (
    not (config ? 'keyword')
    or (
      jsonb_typeof(config -> 'keyword') = 'string'
      and char_length(config ->> 'keyword') between 1 and 256
      and (config ->> 'keyword') ~ '[^[:space:]]'
    )
  )
);

create index monitors_org_id_idx on monitors (org_id);
-- Story 5.8 adds its own index for the due query.
create index monitors_service_id_idx on monitors (service_id);

alter table monitors enable row level security;
alter table monitors force row level security;

create policy monitors_org_isolation
on monitors
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- v1 has no monitor delete (DOMAIN: an operator disables a monitor instead).
-- ALTER DEFAULT PRIVILEGES gave watchdog_app DELETE on this table at creation,
-- so anything holding a tenant transaction could delete a monitor with raw SQL.
-- Revoke it, as revoke_service_delete does for services. Deleting an
-- organization or a service still cascades, which runs as the table owner.
revoke delete on monitors from watchdog_app;

-- migrate:down
grant delete on monitors to watchdog_app;
drop table if exists monitors;
