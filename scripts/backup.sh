#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
RECORDINGS_DIR="${RECORDINGS_DIR:-${ROOT_DIR}/infra/freeswitch/recordings}"
TEXTFILE_DIR="${ROOT_DIR}/monitoring/textfile"

[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
set -a
source "${ENV_FILE}"
set +a

BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
if [[ "${BACKUP_DIR}" != /* ]]; then
  BACKUP_DIR="${ROOT_DIR}/${BACKUP_DIR#./}"
fi

: "${POSTGRES_DB:?Missing POSTGRES_DB}"
: "${POSTGRES_USER:?Missing POSTGRES_USER}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?Missing BACKUP_ENCRYPTION_PASSPHRASE}"

mkdir -p "${BACKUP_DIR}" "${TEXTFILE_DIR}"
umask 077
chmod 700 "${BACKUP_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
work_dir="$(mktemp -d "${BACKUP_DIR}/.outbound-dialer-${timestamp}.XXXXXX")"
archive_path="${BACKUP_DIR}/outbound-dialer-${timestamp}.tar.gz.enc"
quiesced_services=()

resume_quiesced_services() {
  local service
  for service in "${quiesced_services[@]}"; do
    compose unpause "${service}" >/dev/null 2>&1 || true
  done
  quiesced_services=()
}

cleanup() {
  resume_quiesced_services
  rm -rf "${work_dir}"
}
trap cleanup EXIT

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

compose up -d postgres >/dev/null
if [[ "$(compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --tuples-only --no-align --command "select to_regclass('public.calls') is not null")" == "t" ]]; then
  active_calls="$(compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --tuples-only --no-align --command "select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled')")"
  if [[ "${active_calls}" != "0" ]]; then
    echo "Refusing backup while ${active_calls} call(s) are active; no consistent database/media snapshot can be taken" >&2
    exit 1
  fi
fi

if [[ "${BACKUP_QUIESCE_SERVICES:-true}" == "true" ]]; then
  for service in api freeswitch; do
    container_id="$(compose ps -q "${service}")"
    if [[ -n "${container_id}" && "$(docker inspect --format '{{.State.Status}}' "${container_id}")" == "running" ]]; then
      compose pause "${service}" >/dev/null
      quiesced_services+=("${service}")
    fi
  done
elif [[ "${ALLOW_NON_QUIESCED_BACKUP:-false}" != "true" ]]; then
  echo "Set ALLOW_NON_QUIESCED_BACKUP=true to acknowledge that DB and media may not form a consistent snapshot" >&2
  exit 1
fi

compose exec -T postgres pg_dump --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --format custom > "${work_dir}/database.dump"
tar -czf "${work_dir}/recordings.tar.gz" -C "${RECORDINGS_DIR}" .
resume_quiesced_services

cat > "${work_dir}/metadata.txt" <<EOF
created_at=${timestamp}
source_commit=$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)
postgres_database=${POSTGRES_DB}
recordings_directory=${RECORDINGS_DIR}
EOF

tar -czf "${work_dir}/bundle.tar.gz" -C "${work_dir}" database.dump recordings.tar.gz metadata.txt
node "${ROOT_DIR}/scripts/backup-envelope.mjs" encrypt "${work_dir}/bundle.tar.gz" "${archive_path}"
chmod 600 "${archive_path}"

if ! ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/verify-backup.sh" "${archive_path}"; then
  echo "Backup verification failed; refusing upload and success metric publication" >&2
  exit 1
fi

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  command -v aws >/dev/null || { echo "BACKUP_S3_URI requires the aws CLI" >&2; exit 1; }
  aws s3 cp "${archive_path}" "${BACKUP_S3_URI%/}/$(basename "${archive_path}")" --only-show-errors
fi

metric_tmp="${TEXTFILE_DIR}/.outbound_dialer_backup.prom.$$"
printf 'outbound_dialer_backup_last_success_timestamp_seconds %s\n' "$(date +%s)" > "${metric_tmp}"
printf 'outbound_dialer_backup_last_size_bytes %s\n' "$(stat -c '%s' "${archive_path}")" >> "${metric_tmp}"
mv "${metric_tmp}" "${TEXTFILE_DIR}/outbound_dialer_backup.prom"
chmod 644 "${TEXTFILE_DIR}/outbound_dialer_backup.prom"

find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'outbound-dialer-*.tar.gz.enc' \
  -mtime "+${BACKUP_RETENTION_DAYS:-30}" -delete

echo "Encrypted backup completed: ${archive_path}"
