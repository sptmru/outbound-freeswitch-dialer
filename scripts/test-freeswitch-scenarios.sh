#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"

set -a
source "${ENV_FILE}"
set +a

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

fs() {
  compose exec -T freeswitch fs_cli -H 127.0.0.1 -P 8021 -p "${FREESWITCH_ESL_PASSWORD}" -x "$1"
}

fs status | grep -q 'UP'
fs 'module_exists mod_avmd' | grep -qi 'true'
fs 'sofia status' | grep -q 'internal-webrtc'

compose exec -T freeswitch sh -ec '
  config_dir="${FREESWITCH_CONFIG_DIR:-/usr/share/freeswitch/conf/vanilla}"
  grep -q '\''<param name="context" value="agent-ingress"/>'\'' "$config_dir/sip_profiles/internal-webrtc.xml"
  grep -q '\''403 Backend call control required'\'' "$config_dir/dialplan/agent-ingress/reject.xml"
  grep -q '\''403 Inbound calling is not enabled'\'' "$config_dir/dialplan/public/reject.xml"
  if grep -R -E '\''sofia/(gateway|external)/'\'' "$config_dir/dialplan"; then
    echo "Dialplan contains a direct PSTN route; backend-owned call control is not enforced" >&2
    exit 1
  fi
'

api_health="$(curl -fsS --max-time 5 "http://127.0.0.1:${API_PUBLIC_PORT:-3000}/health/ready")"
[[ "${api_health}" == *'"status":"ok"'* ]]

while IFS='|' read -r call_id agent_uuid customer_uuid; do
  [[ -n "${call_id}" ]] || continue
  for uuid in "${agent_uuid}" "${customer_uuid}"; do
    [[ -n "${uuid}" ]] || continue
    result="$(fs "uuid_exists ${uuid}" | tr -d '\r\n')"
    if [[ "${result}" != "true" && "${result}" != "false" ]]; then
      echo "Unexpected uuid_exists response for call ${call_id}: ${result}" >&2
      exit 1
    fi
  done
done < <(
  compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -At -F '|' -c \
    "select calls.id,
            coalesce(agent_leg.freeswitch_uuid, ''),
            coalesce(customer_leg.freeswitch_uuid, '')
       from calls
       left join lateral (
         select freeswitch_uuid
           from call_legs
          where call_id = calls.id and type = 'agent'
          order by created_at desc
          limit 1
       ) agent_leg on true
       left join lateral (
         select freeswitch_uuid
           from call_legs
          where call_id = calls.id and type = 'customer'
          order by created_at desc
          limit 1
       ) customer_leg on true
      where calls.ended_at is null
      order by calls.created_at"
)

echo "FreeSWITCH/ESL runtime scenario checks passed"
