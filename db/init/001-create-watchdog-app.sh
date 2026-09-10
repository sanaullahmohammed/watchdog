#!/bin/sh
# Creates the runtime application role.
#
# Runs once, on first initialisation of the Postgres data volume. The role is
# created here rather than in a migration so that no password ever lives in
# committed SQL; the value comes from the environment per environment.
# See ARCHITECTURE.md section 6.1.
#
# watchdog_owner owns the schema and runs DBMate. watchdog_app is what `api`,
# `worker` and the test suites connect as: no superuser, and critically no
# BYPASSRLS, since FORCE ROW LEVEL SECURITY only defeats the table owner.
set -e

if [ -z "$WATCHDOG_APP_PASSWORD" ]; then
  echo "WATCHDOG_APP_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  -v app_password="$WATCHDOG_APP_PASSWORD" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'EOSQL'
-- %L quotes the password as a literal, so it is never interpolated by the shell.
select format(
  'create role watchdog_app login password %L '
  || 'nosuperuser nocreatedb nocreaterole noinherit nobypassrls',
  :'app_password'
)
where not exists (select 1 from pg_roles where rolname = 'watchdog_app')
\gexec
EOSQL

echo "watchdog_app role is present"
