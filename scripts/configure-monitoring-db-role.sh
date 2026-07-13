#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"

[[ -f "${ENV_FILE}" ]] || { echo "Missing environment file: ${ENV_FILE}" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${POSTGRES_DB:?Missing POSTGRES_DB}"
: "${POSTGRES_USER:?Missing POSTGRES_USER}"
: "${POSTGRES_EXPORTER_PASSWORD:?Missing POSTGRES_EXPORTER_PASSWORD}"
if [[ "${#POSTGRES_EXPORTER_PASSWORD}" -lt 32 ]]; then
  echo "POSTGRES_EXPORTER_PASSWORD must contain at least 32 characters" >&2
  exit 1
fi

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

# \getenv keeps the password out of SQL interpolation and command-line arguments;
# format(%L) quotes it as a PostgreSQL literal before the generated statements run.
compose exec -T -e POSTGRES_EXPORTER_PASSWORD="${POSTGRES_EXPORTER_PASSWORD}" postgres \
  psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  --set=ON_ERROR_STOP=1 --set=database_name="${POSTGRES_DB}" <<'SQL'
\getenv exporter_password POSTGRES_EXPORTER_PASSWORD

SELECT format(
  'CREATE ROLE outbound_dialer_exporter WITH LOGIN PASSWORD %L',
  :'exporter_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'outbound_dialer_exporter'
) \gexec

SELECT format(
  'ALTER ROLE outbound_dialer_exporter WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'exporter_password'
) \gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO outbound_dialer_exporter',
  :'database_name'
) \gexec
GRANT pg_monitor TO outbound_dialer_exporter;
ALTER ROLE outbound_dialer_exporter SET default_transaction_read_only = on;
REVOKE ALL ON SCHEMA public FROM outbound_dialer_exporter;
SQL

echo "PostgreSQL monitoring role configured"
