-- migrate:up
-- Grants for the runtime role. The role itself is created outside migrations
-- (db/init/001-create-watchdog-app.sh in Compose, an explicit step in CI) so
-- that no password appears in committed SQL. See ARCHITECTURE.md section 6.1.
--
-- ALTER DEFAULT PRIVILEGES is the load-bearing half: it applies to objects
-- created later by watchdog_owner, so every future WatchDog table is granted
-- automatically and no migration has to remember to do it.
grant usage on schema public to watchdog_app;

grant select, insert, update, delete
  on all tables in schema public to watchdog_app;

grant usage, select
  on all sequences in schema public to watchdog_app;

alter default privileges in schema public
  grant select, insert, update, delete on tables to watchdog_app;

alter default privileges in schema public
  grant usage, select on sequences to watchdog_app;

-- migrate:down
alter default privileges in schema public
  revoke usage, select on sequences from watchdog_app;

alter default privileges in schema public
  revoke select, insert, update, delete on tables from watchdog_app;

revoke usage, select
  on all sequences in schema public from watchdog_app;

revoke select, insert, update, delete
  on all tables in schema public from watchdog_app;

revoke usage on schema public from watchdog_app;
