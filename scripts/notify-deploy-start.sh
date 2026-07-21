#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
DEPLOY_VERSION="${1:-}"

[[ "${DEPLOY_VERSION}" =~ ^[0-9a-f]{12}$ ]] || {
  echo "Usage: $0 <12-character-git-sha>" >&2
  exit 2
}

compose() {
  APP_ENV_FILE="${ENV_FILE}" APP_VERSION="${APP_VERSION:-${DEPLOY_VERSION}}" \
    docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

if [[ -z "$(compose ps --status running -q alertmanager)" ]]; then
  echo "No running Alertmanager found; skipping the initial-install deployment alert"
  exit 0
fi

payload="$(printf '[{"labels":{"alertname":"DeploymentStarting","severity":"warning","service":"outbound-dialer","release":"%s"},"annotations":{"summary":"Outbound Dialer deployment is starting","description":"Expected service downtime: up to 5 minutes."}}]' "${DEPLOY_VERSION}")"

# Load the just-rendered configuration so the dedicated deployment route sends
# immediately, then submit a synthetic alert. With no explicit endsAt,
# Alertmanager resolves it after the configured 5-minute resolve timeout.
compose exec -T alertmanager wget -q -O /dev/null --post-data="" http://127.0.0.1:9093/-/reload
compose exec -T alertmanager wget -q -O /dev/null \
  --header="Content-Type: application/json" \
  --post-data="${payload}" \
  http://127.0.0.1:9093/api/v2/alerts

echo "Deployment alert sent for ${DEPLOY_VERSION}; expected downtime is up to 5 minutes"
