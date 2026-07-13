#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
STATE_FILE="${ROOT_DIR}/logs/deployment-state.env"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/deployment-state.sh"

[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
[[ -f "${STATE_FILE}" ]] || { echo "No deployment state found" >&2; exit 1; }
set -a
source "${ENV_FILE}"
set +a
deployment_state_load "${STATE_FILE}"

case "${DEPLOYMENT_STATUS}" in
  stable)
    failed_version="${CURRENT_VERSION}"
    default_target_version="${PREVIOUS_VERSION}"
    ;;
  pending_deploy | failed_deploy)
    failed_version="${FAILED_VERSION:-${PENDING_VERSION}}"
    default_target_version="${CURRENT_VERSION}"
    ;;
  pending_rollback | failed_rollback)
    failed_version="${FAILED_VERSION:-${CURRENT_VERSION}}"
    default_target_version="${PENDING_VERSION}"
    ;;
  *)
    echo "Rollback cannot resolve deployment state ${DEPLOYMENT_STATUS}; inspect ${STATE_FILE} first" >&2
    exit 1
    ;;
esac

target_version="${1:-${default_target_version}}"
[[ -n "${target_version}" ]] || { echo "No rollback version available" >&2; exit 1; }
[[ "${ROLLBACK_CONFIRM:-}" == "rollback-${target_version}" ]] || { echo "Set ROLLBACK_CONFIRM=rollback-${target_version}" >&2; exit 1; }

for image in api web proxy freeswitch; do
  docker image inspect "outbound-dialer-${image}:${target_version}" >/dev/null
done

current_version="${CURRENT_VERSION}"
previous_version="${PREVIOUS_VERSION}"
current_deployed_at="${DEPLOYED_AT}"
success_previous_version="${failed_version}"
if [[ "${target_version}" == "${failed_version}" && -n "${PENDING_VERSION}" && "${PENDING_VERSION}" != "${target_version}" ]]; then
  success_previous_version="${PENDING_VERSION}"
fi

deployment_state_write \
  "${STATE_FILE}" \
  "pending_rollback" \
  "${current_version}" \
  "${previous_version}" \
  "${target_version}" \
  "${failed_version}" \
  "rollback" \
  "${current_deployed_at}"

mark_rollback_failed() {
  local exit_code=$?
  trap - ERR
  deployment_state_write \
    "${STATE_FILE}" \
    "failed_rollback" \
    "${current_version}" \
    "${previous_version}" \
    "${target_version}" \
    "${failed_version}" \
    "rollback" \
    "${current_deployed_at}" || true
  echo "Rollback failed; ${STATE_FILE} retains target ${target_version} as unconfirmed" >&2
  exit "${exit_code}"
}
trap mark_rollback_failed ERR

APP_ENV_FILE="${ENV_FILE}" APP_VERSION="${target_version}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  up -d --no-build --wait api web proxy freeswitch
WEB_SMOKE_URL="${WEB_SMOKE_URL:-https://${LETSENCRYPT_DOMAIN}}" "${ROOT_DIR}/scripts/smoke-web.sh"
deployment_state_write \
  "${STATE_FILE}" \
  "stable" \
  "${target_version}" \
  "${success_previous_version}" \
  "" \
  "" \
  "" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
trap - ERR
echo "Application rollback completed to ${target_version}; database migrations remain forward-only"
