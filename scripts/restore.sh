#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
RECORDINGS_DIR="${RECORDINGS_DIR:-${ROOT_DIR}/infra/freeswitch/recordings}"
BACKUP_FILE="${1:-}"
STATE_FILE="${ROOT_DIR}/logs/deployment-state.env"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/deployment-state.sh"

[[ -n "${BACKUP_FILE}" && -f "${BACKUP_FILE}" ]] || { echo "Usage: RESTORE_CONFIRM=restore-<database> $0 <backup.tar.gz.enc>" >&2; exit 1; }
set -a
source "${ENV_FILE}"
set +a
state_exists=false
if [[ -f "${STATE_FILE}" ]]; then
  state_exists=true
fi
deployment_state_load "${STATE_FILE}"
if [[ "${state_exists}" == "true" && "${DEPLOYMENT_STATUS}" != "stable" ]]; then
  echo "Refusing restore while deployment state is ${DEPLOYMENT_STATUS}; resolve ${STATE_FILE} first" >&2
  exit 1
fi
state_current_version="${CURRENT_VERSION}"
state_previous_version="${PREVIOUS_VERSION}"
state_deployed_at="${DEPLOYED_AT}"
APP_VERSION="${APP_VERSION:-${state_current_version}}"
APP_VERSION="${APP_VERSION:-$(git -C "${ROOT_DIR}" rev-parse --short=12 HEAD)}"
export APP_VERSION
checkout_version="$(git -C "${ROOT_DIR}" rev-parse --short=12 HEAD)"
[[ "${APP_VERSION}" =~ ^[0-9a-f]{12}$ ]] || { echo "APP_VERSION must be a 12-character Git SHA" >&2; exit 1; }
[[ -z "$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=normal)" ]] || {
  echo "Refusing restore from a dirty working tree" >&2
  exit 1
}
if [[ "${checkout_version}" != "${APP_VERSION}" && "${ALLOW_COMPATIBLE_RESTORE_VERSION:-false}" != "true" ]]; then
  echo "Checked-out version ${checkout_version} differs from restore runtime ${APP_VERSION}; check out the exact release or explicitly set ALLOW_COMPATIBLE_RESTORE_VERSION=true" >&2
  exit 1
fi
: "${POSTGRES_DB:?Missing POSTGRES_DB}"
: "${POSTGRES_USER:?Missing POSTGRES_USER}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?Missing BACKUP_ENCRYPTION_PASSPHRASE}"
[[ "${RESTORE_CONFIRM:-}" == "restore-${POSTGRES_DB}" ]] || { echo "Set RESTORE_CONFIRM=restore-${POSTGRES_DB}" >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
if ! node "${ROOT_DIR}/scripts/backup-envelope.mjs" decrypt "${BACKUP_FILE}" "${work_dir}/bundle.tar.gz"; then
  if [[ "${ALLOW_LEGACY_UNAUTHENTICATED_BACKUP:-false}" != "true" ]]; then
    echo "Refusing a legacy unauthenticated backup. Set ALLOW_LEGACY_UNAUTHENTICATED_BACKUP=true only for a trusted pre-upgrade archive." >&2
    exit 1
  fi
  rm -f "${work_dir}/bundle.tar.gz"
  echo "WARNING: decrypting a legacy AES-CBC backup without authenticated integrity" >&2
  openssl enc -d -aes-256-cbc -pbkdf2 -in "${BACKUP_FILE}" -out "${work_dir}/bundle.tar.gz" -pass env:BACKUP_ENCRYPTION_PASSPHRASE
fi
tar -xzf "${work_dir}/bundle.tar.gz" -C "${work_dir}"
tar -tzf "${work_dir}/recordings.tar.gz" >/dev/null
backup_source_commit=""
if [[ -f "${work_dir}/metadata.txt" ]]; then
  while IFS='=' read -r metadata_key metadata_value; do
    if [[ "${metadata_key}" == "source_commit" ]]; then
      backup_source_commit="${metadata_value}"
      break
    fi
  done < "${work_dir}/metadata.txt"
fi
if [[ "${backup_source_commit}" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ \
  && "${APP_VERSION}" != "${backup_source_commit:0:12}" \
  && "${ALLOW_COMPATIBLE_RESTORE_VERSION:-false}" != "true" ]]; then
  echo "Backup was created by ${backup_source_commit:0:12}, not ${APP_VERSION}; use the matching release or explicitly approve a compatible release" >&2
  exit 1
fi

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

mkdir -p "${ROOT_DIR}/logs" "${ROOT_DIR}/monitoring/generated" "${RECORDINGS_DIR}"
missing_release_image=false
for image in api web proxy freeswitch pcap; do
  if ! docker image inspect "outbound-dialer-${image}:${APP_VERSION}" >/dev/null 2>&1; then
    missing_release_image=true
  fi
done
if [[ "${missing_release_image}" == "true" ]]; then
  [[ "${APP_VERSION}" == "${checkout_version}" ]] || {
    echo "Release image ${APP_VERSION} is missing; check out that exact commit before rebuilding it" >&2
    exit 1
  }
  [[ -z "$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=normal)" ]] || {
    echo "Refusing to build restore images from a dirty working tree" >&2
    exit 1
  }
  compose build api web proxy freeswitch pcap-capture
fi
compose run --rm monitoring-config
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/validate-monitoring-config.sh"

deployment_state_write \
  "${STATE_FILE}" \
  "pending_restore" \
  "${state_current_version}" \
  "${state_previous_version}" \
  "${APP_VERSION}" \
  "" \
  "restore" \
  "${state_deployed_at}"

mark_restore_failed() {
  local exit_code=$?
  trap - ERR
  deployment_state_write \
    "${STATE_FILE}" \
    "failed_restore" \
    "${state_current_version}" \
    "${state_previous_version}" \
    "${APP_VERSION}" \
    "${APP_VERSION}" \
    "restore" \
    "${state_deployed_at}" || true
  echo "Restore failed; ${STATE_FILE} records ${APP_VERSION} as an unconfirmed restored release" >&2
  exit "${exit_code}"
}
trap mark_restore_failed ERR

compose stop api freeswitch pcap-capture
compose up -d postgres
compose exec -T postgres pg_restore \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction < "${work_dir}/database.dump"
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/configure-monitoring-db-role.sh"

if [[ "${RESTORE_RECORDINGS:-true}" == "true" ]]; then
  recordings_snapshot="${RECORDINGS_DIR}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "${RECORDINGS_DIR}" "${recordings_snapshot}"
  find "${RECORDINGS_DIR}" -mindepth 1 ! -name .gitkeep -delete
  tar -xzf "${work_dir}/recordings.tar.gz" -C "${RECORDINGS_DIR}"
  echo "Previous recordings snapshot: ${recordings_snapshot}"
fi

compose up -d --wait
compose exec -T prometheus wget -q -O /dev/null --post-data="" http://127.0.0.1:9090/-/reload
ENV_FILE="${ENV_FILE}" APP_VERSION="${APP_VERSION}" "${ROOT_DIR}/scripts/ensure-cert.sh"
WEB_SMOKE_URL="${WEB_SMOKE_URL:-https://${LETSENCRYPT_DOMAIN}}" "${ROOT_DIR}/scripts/smoke-web.sh"
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/install-cert-renew-cron.sh"
ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/install-backup-cron.sh"

restore_previous_version="${state_current_version}"
if [[ -z "${restore_previous_version}" || "${restore_previous_version}" == "${APP_VERSION}" ]]; then
  restore_previous_version="${state_previous_version}"
fi
deployment_state_write \
  "${STATE_FILE}" \
  "stable" \
  "${APP_VERSION}" \
  "${restore_previous_version}" \
  "" \
  "" \
  "" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
trap - ERR
echo "Restore completed and smoke-tested"
