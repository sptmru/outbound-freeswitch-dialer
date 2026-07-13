#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
BACKUP_SCRIPT="${ROOT_DIR}/scripts/backup.sh"
LOG_FILE="${ROOT_DIR}/logs/backup.log"
[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
command -v crontab >/dev/null || { echo "Missing required command: crontab" >&2; exit 1; }
ENV_FILE="$(cd "$(dirname "${ENV_FILE}")" && pwd)/$(basename "${ENV_FILE}")"

set -a
source "${ENV_FILE}"
set +a

CRON_SCHEDULE="${BACKUP_CRON_SCHEDULE:-37 2 * * *}"
[[ "${CRON_SCHEDULE}" != *$'\n'* && "${CRON_SCHEDULE}" != *$'\r'* ]] \
  || { echo "BACKUP_CRON_SCHEDULE must be a single five-field cron expression" >&2; exit 1; }
IFS=$' \t' read -r -a schedule_fields <<< "${CRON_SCHEDULE}"
[[ "${#schedule_fields[@]}" -eq 5 ]] \
  || { echo "BACKUP_CRON_SCHEDULE must contain exactly five fields" >&2; exit 1; }
for field in "${schedule_fields[@]}"; do
  [[ "${field}" =~ ^[A-Za-z0-9*/,-]+$ ]] \
    || { echo "BACKUP_CRON_SCHEDULE contains an unsupported field: ${field}" >&2; exit 1; }
done
CRON_SCHEDULE="${schedule_fields[*]}"
printf -v quoted_env_file '%q' "${ENV_FILE}"
printf -v quoted_backup_script '%q' "${BACKUP_SCRIPT}"
printf -v quoted_log_file '%q' "${LOG_FILE}"
CRON_LINE="${CRON_SCHEDULE} ENV_FILE=${quoted_env_file} ${quoted_backup_script} >> ${quoted_log_file} 2>&1"

mkdir -p "${ROOT_DIR}/logs"
candidate_crontab="$(mktemp)"
trap 'rm -f "${candidate_crontab}"' EXIT
(
  crontab -l 2>/dev/null | grep -v -F "${BACKUP_SCRIPT}" || true
  printf '%s\n' "${CRON_LINE}"
) > "${candidate_crontab}"
if ! crontab "${candidate_crontab}"; then
  echo "BACKUP_CRON_SCHEDULE was rejected by crontab" >&2
  exit 1
fi
rm -f "${candidate_crontab}"
trap - EXIT

echo "Installed backup cron: ${CRON_LINE}"
