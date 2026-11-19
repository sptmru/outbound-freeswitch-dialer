#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"
RECORDINGS_DIR="${RECORDINGS_DIR:-${ROOT_DIR}/infra/freeswitch/recordings}"
TEXTFILE_DIR="${ROOT_DIR}/monitoring/textfile"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/host-operation-lock.sh"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/backup-ingress-journal.sh"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/deployment-state.sh"
acquire_host_operation_lock "${ROOT_DIR}" "backup"

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
  local resume_status=0
  local -a still_quiesced_services=()
  for service in "${quiesced_services[@]}"; do
    if ! compose unpause "${service}" >/dev/null; then
      echo "Failed to resume quiesced ${service} service" >&2
      still_quiesced_services+=("${service}")
      resume_status=1
    fi
  done
  quiesced_services=("${still_quiesced_services[@]}")
  return "${resume_status}"
}

cleanup() {
  if ! resume_quiesced_services; then
    echo "Backup cleanup could not resume all quiesced services; operator recovery is required" >&2
  fi
  rm -rf "${work_dir}"
}
trap cleanup EXIT

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

compose up -d --wait postgres >/dev/null
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

if [[ "${BACKUP_QUIESCE_SERVICES:-true}" == "true" && "${active_calls:-}" == "0" ]]; then
  active_calls="$(compose exec -T postgres psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --tuples-only --no-align --command "select count(*) from calls where state not in ('completed', 'failed', 'canceled')")"
  [[ "${active_calls}" == "0" ]] || {
    echo "Call admission raced backup quiescing; retry after calls drain" >&2
    exit 1
  }
fi

ingress_journal=absent
if ingress_journal_volume_exists; then
  # The Compose default image tag may differ from the deployed sidecar image.
  journal_container="$(compose ps --all -q ingress-journal)"
  if [[ -n "${journal_container}" ]]; then
    journal_image="$(docker inspect --format '{{.Config.Image}}' "${journal_container}")"
    export APP_VERSION="${journal_image##*:}"
    FREESWITCH_INGRESS_SOCKET="$(docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "FREESWITCH_INGRESS_SOCKET"}}{{.}}{{end}}{{end}}' "${journal_container}")"
    export FREESWITCH_INGRESS_SOCKET="${FREESWITCH_INGRESS_SOCKET#*=}"
  elif [[ -z "${APP_VERSION:-}" ]]; then
    deployment_state_load "${ROOT_DIR}/logs/deployment-state.env"
    export APP_VERSION="${CURRENT_VERSION}"
  fi
  run_ingress_journal_tool snapshot > "${work_dir}/ingress.sqlite"
  if [[ -s "${work_dir}/ingress.sqlite" ]]; then
    [[ "${BACKUP_QUIESCE_SERVICES:-true}" == "true" ]] || {
      echo "Quiesce API and FreeSWITCH to back up ingress with PostgreSQL" >&2
      exit 1
    }
    ingress_journal=present
  else
    rm "${work_dir}/ingress.sqlite"
  fi
elif [[ "$?" != "1" ]]; then
  echo "Could not inspect the ingress journal volume" >&2
  exit 1
fi
if [[ "${FREESWITCH_INGRESS_ENABLED:-false}" == "true" && "${ingress_journal}" != "present" ]]; then
  echo "Enabled ingress has no journal snapshot; check the sidecar and its volume" >&2
  exit 1
fi

compose exec -T postgres pg_dump --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" --format custom > "${work_dir}/database.dump"
tar -czf "${work_dir}/recordings.tar.gz" -C "${RECORDINGS_DIR}" .
if ! resume_quiesced_services; then
  echo "Backup snapshot was captured, but runtime services could not be resumed; refusing to publish a backup success" >&2
  exit 1
fi

cat > "${work_dir}/metadata.txt" <<EOF
created_at=${timestamp}
source_commit=$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)
postgres_database=${POSTGRES_DB}
recordings_directory=${RECORDINGS_DIR}
ingress_journal=${ingress_journal}
EOF

bundle_members=(database.dump recordings.tar.gz metadata.txt)
if [[ "${ingress_journal}" == "present" ]]; then
  bundle_members+=(ingress.sqlite)
fi
tar -czf "${work_dir}/bundle.tar.gz" -C "${work_dir}" "${bundle_members[@]}"
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
