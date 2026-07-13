#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STATE_FILE="${ROOT_DIR}/logs/deployment-state.env"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/deployment-state.sh"

if [[ "${DEPLOY_PULL:-false}" == "true" ]]; then
  git -C "${ROOT_DIR}" pull --ff-only
  export DEPLOY_PULL=false
  exec "${BASH_SOURCE[0]}" "$@"
fi

ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/preflight.sh"

mkdir -p "${ROOT_DIR}/logs" "${ROOT_DIR}/monitoring/generated"

new_version="$(git -C "${ROOT_DIR}" rev-parse --short=12 HEAD)"
deployment_state_load "${STATE_FILE}"
current_version="${CURRENT_VERSION}"
previous_version="${PREVIOUS_VERSION}"
current_deployed_at="${DEPLOYED_AT}"
if [[ -f "${STATE_FILE}" && "${DEPLOYMENT_STATUS}" != "stable" ]]; then
  echo "Refusing a new deploy while deployment state is ${DEPLOYMENT_STATUS}; resolve PENDING_VERSION=${PENDING_VERSION:-none} first" >&2
  exit 1
fi

compose() {
  APP_ENV_FILE="${ENV_FILE}" APP_VERSION="${new_version}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

if [[ "${SKIP_DEPLOY_CHECKS:-false}" != "true" ]]; then
  npm --prefix "${ROOT_DIR}" ci
  npm --prefix "${ROOT_DIR}" run quality
fi

# Load deployment secrets only after source/dependency/quality commands have
# completed, so npm lifecycle processes never inherit the production secret set.
set -a
source "${ENV_FILE}"
set +a

if curl -fsS --max-time 5 "http://127.0.0.1:${API_PUBLIC_PORT:-3000}/metrics" > "${ROOT_DIR}/logs/pre-deploy-metrics.prom" 2>/dev/null; then
  active_calls="$(awk '/^outbound_dialer_active_calls / { print $2 }' "${ROOT_DIR}/logs/pre-deploy-metrics.prom")"
  [[ "${active_calls:-}" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "Could not verify active-call metric" >&2; exit 1; }
  if awk -v value="${active_calls}" 'BEGIN { exit !(value > 0) }' \
    && [[ "${ALLOW_ACTIVE_CALL_DEPLOY:-false}" != "true" ]]; then
    echo "Refusing to deploy with ${active_calls} active call(s)" >&2
    exit 1
  fi
elif [[ -f "${STATE_FILE}" && "${ALLOW_UNVERIFIED_ACTIVE_CALL_STATE:-false}" != "true" ]]; then
  echo "Refusing an upgrade because the current API active-call state could not be verified" >&2
  exit 1
fi

if [[ "${SKIP_PRE_DEPLOY_BACKUP:-false}" != "true" ]]; then
  ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/backup.sh"
fi

compose pull --ignore-buildable
compose build api freeswitch web proxy
compose run --rm monitoring-config
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/validate-monitoring-config.sh"

deployment_state_write \
  "${STATE_FILE}" \
  "pending_deploy" \
  "${current_version}" \
  "${previous_version}" \
  "${new_version}" \
  "" \
  "deploy" \
  "${current_deployed_at}"

mark_deploy_failed() {
  local exit_code=$?
  trap - ERR
  deployment_state_write \
    "${STATE_FILE}" \
    "failed_deploy" \
    "${current_version}" \
    "${previous_version}" \
    "${new_version}" \
    "${new_version}" \
    "deploy" \
    "${current_deployed_at}" || true
  echo "Deployment failed; ${STATE_FILE} records ${new_version} as an unconfirmed pending release" >&2
  exit "${exit_code}"
}
trap mark_deploy_failed ERR

compose up -d --wait postgres freeswitch
compose run --rm --no-deps api npm --workspace @outbound-dialer/api run migrate
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/configure-monitoring-db-role.sh"
compose up -d --wait
# Generated monitoring files are bind-mounted, so Compose does not recreate an
# already-running Prometheus container when only their contents change.
compose exec -T prometheus wget -q -O /dev/null --post-data="" http://127.0.0.1:9090/-/reload
ENV_FILE="${ENV_FILE}" APP_VERSION="${new_version}" "${ROOT_DIR}/scripts/ensure-cert.sh"
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/install-cert-renew-cron.sh"
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/install-backup-cron.sh"
WEB_SMOKE_URL="${WEB_SMOKE_URL:-https://${LETSENCRYPT_DOMAIN}}" "${ROOT_DIR}/scripts/smoke-web.sh"
compose ps

deployment_state_write \
  "${STATE_FILE}" \
  "stable" \
  "${new_version}" \
  "${current_version}" \
  "" \
  "" \
  "" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
trap - ERR
echo "Deployment completed for ${new_version}"
