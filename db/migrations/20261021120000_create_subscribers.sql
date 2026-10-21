-- migrate:up
-- Public email subscribers of an organization's status page. DOMAIN.md
-- (Subscriber), ARCHITECTURE.md 5.6, Story 6.3.
create table subscribers (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references "organization" ("id") on delete cascade,
  email text not null,
  status text not null,
  confirmation_token_hash text,
  confirmation_expires_at timestamptz,
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The composite target 6.6's deliveries reference.
  constraint subscribers_id_org_uk unique (id, org_id),
  constraint subscribers_status_ck
    check (status in ('pending', 'confirmed', 'unsubscribed'))
);

create unique index subscribers_org_email_uk
on subscribers (org_id, lower(email));

alter table subscribers enable row level security;
alter table subscribers force row level security;

create policy subscribers_org_isolation
on subscribers
using (
  org_id = current_setting('app.current_org_id', true)
)
with check (
  org_id = current_setting('app.current_org_id', true)
);

-- migrate:down
drop table if exists subscribers;
