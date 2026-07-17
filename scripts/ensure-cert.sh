#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STATE_FILE="${ROOT_DIR}/logs/deployment-state.env"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/host-operation-lock.sh"
acquire_host_operation_lock "${ROOT_DIR}" "certificate reconciliation"

if [[ -z "${APP_VERSION:-}" && -f "${STATE_FILE}" ]]; then
  source "${STATE_FILE}"
  if [[ "${DEPLOYMENT_STATUS:-stable}" != "stable" ]]; then
    echo "Refusing certificate reconciliation while deployment state is ${DEPLOYMENT_STATUS}" >&2
    exit 1
  fi
  export APP_VERSION="${CURRENT_VERSION:-local}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing .env. Start from .env.example and fill deployment values." >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

if [[ -z "${LETSENCRYPT_DOMAIN:-}" ]]; then
  echo "Missing LETSENCRYPT_DOMAIN in .env." >&2
  exit 1
fi

if [[ -z "${LETSENCRYPT_EMAIL:-}" ]]; then
  echo "Missing LETSENCRYPT_EMAIL in .env." >&2
  exit 1
fi

if [[ -z "${GRAFANA_DOMAIN:-}" ]]; then
  echo "Missing GRAFANA_DOMAIN in .env." >&2
  exit 1
fi

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/certificate-runtime.sh"

compose up -d --wait --no-recreate proxy
compose run --rm certbot \
  certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --email "${LETSENCRYPT_EMAIL}" \
  --agree-tos \
  --non-interactive \
  --no-eff-email \
  --keep-until-expiring \
  --expand \
  --cert-name "${LETSENCRYPT_DOMAIN}" \
  -d "${LETSENCRYPT_DOMAIN}" \
  -d "${GRAFANA_DOMAIN}"
apply_certificate_runtime_if_changed "${ROOT_DIR}"
