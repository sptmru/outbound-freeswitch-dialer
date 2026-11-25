#!/usr/bin/env bash

# Compatible with releases that predate the additive admission schema.
call_coordination_database_mode() {
  compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
    --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN to_regclass('public.call_admission_migration') IS NULL
  THEN 'select false'
  ELSE 'select not reconciliation_required and reconciled_at is not null from call_admission_migration'
END \gexec
SQL
}

call_coordination_database_has_history() {
  compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
    --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN to_regclass('public.call_participants') IS NULL
  THEN 'select false'
  ELSE $$select exists(select 1 from call_participants where origin='native')$$
END \gexec
SQL
}
