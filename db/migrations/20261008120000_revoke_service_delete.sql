-- migrate:up
-- Services are archived, never hard-deleted (DOMAIN: v1 has no hard service
-- delete). The original grant gave watchdog_app DELETE on every table, so
-- anything holding a tenant transaction could delete a service with raw SQL.
-- Revoke it, as create_incident_updates does for incident_updates. Deleting an
-- organization still removes its services: a foreign key's on delete cascade
-- runs as the owner of the referencing table, not as the caller.
-- This revoke is one-time. ALTER DEFAULT PRIVILEGES granted DELETE to
-- watchdog_app when services was created, and a later
-- `grant ... on all tables in schema public to watchdog_app` (the pattern of
-- the grant migration) would silently give it back. The grant case in
-- src/modules/service/service-delete-privilege.integration.test.ts is the guard.
revoke delete on services from watchdog_app;

-- migrate:down
grant delete on services to watchdog_app;
