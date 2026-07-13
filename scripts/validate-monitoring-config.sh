#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"

[[ -f "${ENV_FILE}" ]] || { echo "Missing environment file: ${ENV_FILE}" >&2; exit 1; }

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

compose run --rm --no-deps --entrypoint /bin/promtool \
  prometheus check config /etc/prometheus/prometheus.yml
compose run --rm --no-deps --entrypoint /bin/amtool \
  alertmanager check-config /etc/alertmanager/alertmanager.yml
compose run --rm --no-deps --entrypoint /bin/blackbox_exporter \
  blackbox-exporter --config.check --config.file=/etc/blackbox_exporter/config.yml
compose run --rm --no-deps \
  loki -verify-config=true -config.file=/etc/loki/loki.yml -config.expand-env=true
compose run --rm --no-deps --entrypoint /bin/alloy \
  alloy validate /etc/alloy/config.alloy

echo "Monitoring configuration validation passed"
