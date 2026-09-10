-- migrate:up
-- Foreign keys do not respect row level security.
--
-- PostgreSQL performs referential integrity checks with row security disabled,
-- so a tenant can reference a row it cannot read. Verified against this
-- database: as watchdog_app scoped to org A, `select` on another org's
-- service_group returned zero rows while `insert ... references` that same id
-- succeeded. RLS protects reads and writes of a row; it does not protect what a
-- row may point at.
--
-- The fix is structural rather than a check in application code: make org_id
-- part of the key, so the database itself refuses a cross-tenant reference.
-- Every future foreign key between two tenant-scoped tables follows this shape.
-- See DOMAIN.md, Tenant-scoped foreign keys.

alter table service_groups
  add constraint service_groups_id_org_uk unique (id, org_id);

alter table services
  drop constraint services_service_group_id_fkey;

-- MATCH SIMPLE, the default, means the constraint is not enforced when any
-- column is null, so an ungrouped service is still legal.
-- SET NULL names one column because org_id is NOT NULL and must survive.
alter table services
  add constraint services_service_group_id_fkey
  foreign key (service_group_id, org_id)
  references service_groups (id, org_id)
  on delete set null (service_group_id);

-- migrate:down
alter table services drop constraint services_service_group_id_fkey;

alter table services
  add constraint services_service_group_id_fkey
  foreign key (service_group_id) references service_groups (id)
  on delete set null;

alter table service_groups drop constraint service_groups_id_org_uk;
