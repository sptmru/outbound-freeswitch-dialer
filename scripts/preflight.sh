#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"

fail() {
  echo "Preflight failed: $*" >&2
  exit 1
}

[[ -f "${ENV_FILE}" ]] || fail "missing ${ENV_FILE}"

env_mode="$(stat -c '%a' "${ENV_FILE}")"
if (( (8#${env_mode} & 8#077) != 0 )); then
  fail "${ENV_FILE} must not be readable or writable by group/others (run chmod 600 ${ENV_FILE})"
fi

set -a
source "${ENV_FILE}"
set +a

required() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "missing ${name}"
}

strong_secret() {
  local name="$1"
  local value="${!name:-}"
  required "${name}"
  [[ "${#value}" -ge 32 ]] || fail "${name} must contain at least 32 characters"
  [[ ! "${value}" =~ change-me|ClueCon|example|not-configured ]] || fail "${name} contains a placeholder value"
}

ipv4() {
  local value="$1"
  local first second third fourth extra
  IFS=. read -r first second third fourth extra <<< "${value}"
  [[ -z "${extra:-}" && -n "${fourth:-}" ]] || return 1
  for octet in "${first}" "${second}" "${third}" "${fourth}"; do
    [[ "${octet}" =~ ^[0-9]+$ ]] || return 1
    (( 10#${octet} <= 255 )) || return 1
  done
}

public_ipv4() {
  local value="$1"
  local first second _
  ipv4 "${value}" || return 1
  IFS=. read -r first second _ <<< "${value}"
  first=$((10#${first}))
  second=$((10#${second}))
  (( first >= 1 && first <= 223 )) || return 1
  (( first != 10 )) || return 1
  (( first != 100 || second < 64 || second > 127 )) || return 1
  (( first != 127 )) || return 1
  (( first != 169 || second != 254 )) || return 1
  (( first != 172 || second < 16 || second > 31 )) || return 1
  (( first != 192 || second != 168 )) || return 1
}

for command in awk crontab curl docker find git grep mktemp node npm openssl stat tar; do
  command -v "${command}" >/dev/null || fail "missing required command: ${command}"
done

if [[ -n "$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=normal)" ]]; then
  fail "working tree must be clean so the release images exactly match their Git SHA"
fi

required DATABASE_URL
required POSTGRES_DB
required POSTGRES_USER
required NODE_ENV
[[ "${NODE_ENV}" == "production" ]] || fail "NODE_ENV must be production for deployment"
strong_secret POSTGRES_PASSWORD
strong_secret POSTGRES_EXPORTER_PASSWORD
strong_secret JWT_SECRET
strong_secret SIP_SECRET_ENCRYPTION_KEY
strong_secret FREESWITCH_ESL_PASSWORD
strong_secret TURN_SHARED_SECRET
strong_secret GRAFANA_ADMIN_PASSWORD
strong_secret BACKUP_ENCRYPTION_PASSPHRASE
required LETSENCRYPT_DOMAIN
required LETSENCRYPT_EMAIL
required GRAFANA_DOMAIN
required FREESWITCH_EXTERNAL_SIP_IP
required FREESWITCH_EXTERNAL_RTP_IP
required TURN_URLS
required TURN_RELAY_IP
required COTURN_IMAGE
required FAIL2BAN_IGNORE_IPS

[[ "${FAIL2BAN_IGNORE_IPS}" != *$'\n'* && "${FAIL2BAN_IGNORE_IPS}" != *$'\r'* \
  && "${FAIL2BAN_IGNORE_IPS}" =~ ^[A-Za-z0-9_.,:/\ -]+$ ]] \
  || fail "FAIL2BAN_IGNORE_IPS contains unsupported characters"
[[ "${FAIL2BAN_IGNORE_IPS}" != *"0.0.0.0/0"* && "${FAIL2BAN_IGNORE_IPS}" != *"::/0"* ]] \
  || fail "FAIL2BAN_IGNORE_IPS must not trust every address"
[[ " ${FAIL2BAN_IGNORE_IPS//,/ } " == *" 127.0.0.1/8 "* && " ${FAIL2BAN_IGNORE_IPS//,/ } " == *" ::1 "* ]] \
  || fail "FAIL2BAN_IGNORE_IPS must include 127.0.0.1/8 and ::1"

public_ipv4 "${FREESWITCH_EXTERNAL_SIP_IP}" \
  || fail "FREESWITCH_EXTERNAL_SIP_IP must be the literal public/Elastic IPv4 address (not auto-nat or STUN)"
public_ipv4 "${FREESWITCH_EXTERNAL_RTP_IP}" \
  || fail "FREESWITCH_EXTERNAL_RTP_IP must be the literal public/Elastic IPv4 address (not auto-nat or STUN)"
[[ "${FREESWITCH_EXTERNAL_SIP_IP}" == "${FREESWITCH_EXTERNAL_RTP_IP}" ]] \
  || fail "the current single-host topology requires matching FreeSWITCH SIP and RTP public IPs"
ipv4 "${TURN_RELAY_IP}" \
  || fail "TURN_RELAY_IP must be the literal IPv4 address assigned to the host interface used by Coturn"
[[ "${TURN_URLS}" == *"${LETSENCRYPT_DOMAIN}"* ]] \
  || fail "TURN_URLS must use the primary LETSENCRYPT_DOMAIN hostname"
[[ "${COTURN_IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]] \
  || fail "COTURN_IMAGE must use an immutable @sha256 digest"

turn_min_port="${TURN_MIN_PORT:-49152}"
turn_max_port="${TURN_MAX_PORT:-49252}"
turn_port="${TURN_PORT:-3478}"
turn_tls_port="${TURN_TLS_PORT:-5349}"
rtp_start_port="${FREESWITCH_RTP_START_PORT:-16384}"
rtp_end_port="${FREESWITCH_RTP_END_PORT:-16484}"
for port_name in turn_port turn_tls_port turn_min_port turn_max_port rtp_start_port rtp_end_port; do
  [[ "${!port_name}" =~ ^[0-9]+$ && "${!port_name}" -ge 1024 && "${!port_name}" -le 65535 ]] \
    || fail "${port_name} must be a port between 1024 and 65535"
done
(( turn_min_port <= turn_max_port )) || fail "TURN_MIN_PORT must not exceed TURN_MAX_PORT"
(( rtp_start_port <= rtp_end_port )) || fail "FREESWITCH_RTP_START_PORT must not exceed FREESWITCH_RTP_END_PORT"
if (( turn_min_port <= rtp_end_port && rtp_start_port <= turn_max_port )); then
  fail "Coturn relay and FreeSWITCH RTP port ranges must not overlap"
fi

if [[ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ]]; then
  strong_secret BOOTSTRAP_ADMIN_PASSWORD
fi

[[ "${DATABASE_URL}" != *change-me* ]] || fail "DATABASE_URL contains a placeholder value"
[[ "${JWT_EXPIRES_SECONDS:-28800}" -le 28800 ]] || fail "JWT_EXPIRES_SECONDS must not exceed 28800"
[[ "${SIP_SECRET_WRITE_VERSION:-v1}" =~ ^v[12]$ ]] || fail "SIP_SECRET_WRITE_VERSION must be v1 or v2"
if [[ "${SIP_SECRET_WRITE_VERSION:-v1}" == "v2" && "${SIP_SECRET_V2_ROLLBACK_SAFE:-false}" != "true" ]]; then
  fail "SIP v2 writes require a previously deployed dual-read release; set SIP_SECRET_V2_ROLLBACK_SAFE=true only after verifying that rollback target"
fi
[[ -n "${FREESWITCH_BASE_IMAGE:-}" ]] || fail "FREESWITCH_BASE_IMAGE must be explicitly pinned"
[[ "${FREESWITCH_BASE_IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]] \
  || fail "FREESWITCH_BASE_IMAGE must use an immutable @sha256 digest"

if [[ "${FREESWITCH_WS_UPSTREAM_SCHEME:-http}" == "https" ]]; then
  [[ -n "${FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME:-${LETSENCRYPT_DOMAIN:-}}" ]] \
    || fail "HTTPS FreeSWITCH WS upstream requires FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME"
  if [[ "${FREESWITCH_WS_UPSTREAM_TLS_VERIFY:-on}" != "on" \
    && "${ALLOW_UNVERIFIED_FREESWITCH_WS_UPSTREAM:-false}" != "true" ]]; then
    fail "HTTPS FreeSWITCH WS upstream certificate verification must be on (or explicitly acknowledge ALLOW_UNVERIFIED_FREESWITCH_WS_UPSTREAM=true)"
  fi
fi

if [[ "${ALLOW_UNCONFIGURED_SIP_TRUNK:-false}" != "true" ]]; then
  case "${SIP_TRUNK_MODE:-registration}" in
    registration)
      required SIP_TRUNK_PROXY
      required SIP_TRUNK_USERNAME
      required SIP_TRUNK_PASSWORD
      ;;
    ip_auth)
      required SIP_TRUNK_PROXY
      ;;
    *)
      fail "SIP_TRUNK_MODE must be registration or ip_auth"
      ;;
  esac
elif [[ ! "${SIP_TRUNK_MODE:-registration}" =~ ^(registration|ip_auth)$ ]]; then
  fail "SIP_TRUNK_MODE must be registration or ip_auth"
fi

if [[ -n "${ALERTMANAGER_SLACK_WEBHOOK_URL:-}" || -n "${ALERTMANAGER_SLACK_CHANNEL:-}" ]]; then
  [[ -n "${ALERTMANAGER_SLACK_WEBHOOK_URL:-}" && -n "${ALERTMANAGER_SLACK_CHANNEL:-}" ]] \
    || fail "set both ALERTMANAGER_SLACK_WEBHOOK_URL and ALERTMANAGER_SLACK_CHANNEL"
fi

if [[ -z "${ALERTMANAGER_WEBHOOK_URL:-}" \
  && -z "${ALERTMANAGER_SLACK_WEBHOOK_URL:-}" \
  && -z "${ALERTMANAGER_TELEGRAM_BOT_TOKEN:-}" ]]; then
  [[ "${ALLOW_NO_ALERT_RECEIVER:-false}" == "true" ]] || fail "configure an Alertmanager receiver or explicitly set ALLOW_NO_ALERT_RECEIVER=true"
fi

if [[ -z "${BACKUP_S3_URI:-}" && "${ALLOW_LOCAL_ONLY_BACKUPS:-false}" != "true" ]]; then
  fail "configure BACKUP_S3_URI for an off-host backup, or explicitly set ALLOW_LOCAL_ONLY_BACKUPS=true for an accepted local-only risk"
fi
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  command -v aws >/dev/null || fail "BACKUP_S3_URI requires the aws CLI"
fi

APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
echo "Deployment preflight passed"
