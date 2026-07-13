#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STATE_FILE="${ROOT_DIR}/logs/deployment-state.env"

if [[ -z "${APP_VERSION:-}" && -f "${STATE_FILE}" ]]; then
  source "${STATE_FILE}"
  if [[ "${DEPLOYMENT_STATUS:-stable}" != "stable" ]]; then
    echo "Refusing certificate renewal while deployment state is ${DEPLOYMENT_STATUS}" >&2
    exit 1
  fi
  export APP_VERSION="${CURRENT_VERSION:-local}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing .env. Start from .env.example and fill deployment values." >&2
  exit 1
fi

APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d proxy
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" run --rm certbot \
  renew \
  --webroot \
  --webroot-path /var/www/certbot \
  --quiet
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T proxy \
  /docker-entrypoint.d/20-render-outbound-dialer-proxy.sh
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T proxy nginx -s reload
