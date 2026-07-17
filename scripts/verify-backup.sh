#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
BACKUP_FILE="${1:-}"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/host-operation-lock.sh"
acquire_host_operation_lock "${ROOT_DIR}" "backup verification"

[[ -n "${BACKUP_FILE}" && -f "${BACKUP_FILE}" ]] || { echo "Usage: $0 <backup.tar.gz.enc>" >&2; exit 1; }
set -a
source "${ENV_FILE}"
set +a
: "${BACKUP_ENCRYPTION_PASSPHRASE:?Missing BACKUP_ENCRYPTION_PASSPHRASE}"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
node "${ROOT_DIR}/scripts/backup-envelope.mjs" decrypt "${BACKUP_FILE}" "${work_dir}/bundle.tar.gz"
tar -xzf "${work_dir}/bundle.tar.gz" -C "${work_dir}"
tar -tzf "${work_dir}/recordings.tar.gz" >/dev/null
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --wait postgres >/dev/null
APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  exec -T postgres pg_restore --list < "${work_dir}/database.dump" >/dev/null
echo "Backup verification passed: ${BACKUP_FILE}"
