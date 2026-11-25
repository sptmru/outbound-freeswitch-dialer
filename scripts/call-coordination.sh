#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
STATE_FILE="${ROOT_DIR}/logs/deployment-state.env"
source "${ROOT_DIR}/scripts/deployment-state.sh"
source "${ROOT_DIR}/scripts/host-operation-lock.sh"
source "${ROOT_DIR}/scripts/call-coordination-state.sh"
acquire_host_operation_lock "${ROOT_DIR}" "call coordination cutover"

[[ -f "${ENV_FILE}" && -f "${STATE_FILE}" ]] || { echo "A deployed release and environment are required" >&2; exit 1; }
set -a
source "${ENV_FILE}"
set +a
deployment_state_load "${STATE_FILE}"
[[ "${DEPLOYMENT_STATUS}" == stable && -n "${CURRENT_VERSION}" ]] || {
  echo "Call coordination cutover requires a stable release" >&2
  exit 1
}

compose() {
  APP_ENV_FILE="${ENV_FILE}" APP_VERSION="${CURRENT_VERSION}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

cutover() {
  [[ "${CURRENT_VERSION}" == "$(git -C "${ROOT_DIR}" rev-parse --short=12 HEAD)" ]] || {
    echo "Call coordination cutover requires the checkout of the current stable release" >&2
    return 1
  }
  compose run --rm -T --no-deps --pull never api node apps/api/dist/coordination-cutover-cli.js "$@"
}

set_coordination_drain() {
  local paused="$1"
  compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
    --set=ON_ERROR_STOP=1 --command "
      insert into system_settings(key,value_json,updated_at)
      values ('ops.call_start_paused','${paused}'::jsonb,now()),('ops.call_coordination_drain','${paused}'::jsonb,now())
      on conflict (key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at"
}

case "${1:-}" in
  pause)
    set_coordination_drain true
    ;;
  check-drained)
    cutover check-drained
    ;;
  activate)
    [[ "${CALL_COORDINATION_ENABLED:-false}" == true && "${FREESWITCH_INGRESS_ENABLED:-false}" == true &&
       "${FREESWITCH_INBOUND_CONFIG_ENABLED:-false}" == true && -n "${CALL_EXECUTOR_DATABASE_URL:-}" ]] || {
      echo "Set the coordination, ingress and configuration flags and the executor connection before activation" >&2
      exit 1
    }
    previous_core="$(cutover inspect)"
    compose stop api
    cutover inspect >/dev/null
    # A fresh switch incarnation excludes bytes still in flight from any
    # legacy originate sender. The existing call-start gate remains closed.
    compose up -d --no-build --no-deps --wait --force-recreate freeswitch ingress-journal
    cutover activate "${previous_core}"
    compose up -d --no-build --no-deps --wait api
    echo "Coordinated API ready. Call starts are still paused and inbound numbers are disabled."
    ;;
  deactivate)
    cutover check-drained
    compose stop api
    cutover deactivate
    compose stop ingress-journal
    echo "Cutover marker cleared. Set all three feature flags to false before restarting or rolling back the API."
    ;;
  start-feature-off)
    if [[ "${CALL_COORDINATION_ENABLED:-false}" != false || "${FREESWITCH_INGRESS_ENABLED:-false}" != false ||
          "${FREESWITCH_INBOUND_CONFIG_ENABLED:-false}" != false || "$(call_coordination_database_mode)" != f ]]; then
      echo "Clear the cutover marker and set all three feature flags to false first" >&2
      exit 1
    fi
    cutover check-feature-off
    compose up -d --no-build --no-deps --wait freeswitch ingress-journal
    compose up -d --no-build --no-deps --wait api
    echo "Feature-off API ready. Call starts are still paused."
    ;;
  resume)
    compose exec -T api node -e 'fetch("http://127.0.0.1:3000/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
    set_coordination_drain false
    ;;
  *)
    echo "Usage: bash scripts/call-coordination.sh {pause|check-drained|activate|deactivate|start-feature-off|resume}" >&2
    exit 2
    ;;
esac
