#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
ENV_FILE="${ROOT_DIR}/.env"

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

APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d proxy
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" run --rm certbot \
  certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --email "${LETSENCRYPT_EMAIL}" \
  --agree-tos \
  --no-eff-email \
  --keep-until-expiring \
  -d "${LETSENCRYPT_DOMAIN}"
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T proxy \
  /docker-entrypoint.d/20-render-outbound-dialer-proxy.sh
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T proxy nginx -s reload
