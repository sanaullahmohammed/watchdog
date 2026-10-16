-- migrate:up
-- One marker per monitor per certificate fingerprint: the SSL-expiry warning
-- fires once, when the marker is first inserted. DOMAIN.md (MonitorSslWarning,
-- SSL-expiry checks), Story 5.7.
create table monitor_ssl_warnings (
  org_id text not null references "organization" ("id") on delete cascade,
  monitor_id uuid not null,
  certificate_fingerprint text not null,
  certificate_expires_at timestamptz not null,
  warned_at timestamptz not null default now(),

  primary key (org_id, monitor_id, certificate_fingerprint),

  constraint monitor_ssl_warnings_monitor_fkey
    foreign key (monitor_id, org_id)
    references monitors (id, org_id)
    on delete cascade
);

alter table monitor_ssl_warnings enable row level security;
alter table monitor_ssl_warnings force row level security;

create policy monitor_ssl_warnings_org_isolation
on monitor_ssl_warnings
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- Append-only, enforced: an edited or deleted marker would warn again.
revoke update, delete on monitor_ssl_warnings from watchdog_app;

-- migrate:down
drop table if exists monitor_ssl_warnings;
