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
strong_secret GRAFANA_ADMIN_PASSWORD
strong_secret BACKUP_ENCRYPTION_PASSPHRASE
required LETSENCRYPT_DOMAIN
required LETSENCRYPT_EMAIL
required GRAFANA_DOMAIN

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

if [[ -z "${ALERTMANAGER_WEBHOOK_URL:-}" && -z "${ALERTMANAGER_TELEGRAM_BOT_TOKEN:-}" ]]; then
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
