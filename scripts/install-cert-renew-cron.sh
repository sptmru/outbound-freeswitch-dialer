#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
RENEW_SCRIPT="${ROOT_DIR}/scripts/renew-cert.sh"
LOG_FILE="${ROOT_DIR}/logs/cert-renew.log"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/host-operation-lock.sh"
acquire_host_operation_lock "${ROOT_DIR}" "certificate cron installation"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/cron-path.sh"
[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
ENV_FILE="$(cd "$(dirname "${ENV_FILE}")" && pwd)/$(basename "${ENV_FILE}")"
printf -v quoted_env_file '%q' "${ENV_FILE}"
printf -v quoted_renew_script '%q' "${RENEW_SCRIPT}"
printf -v quoted_log_file '%q' "${LOG_FILE}"
cron_path="$(build_cron_path bash crontab docker flock stat)"
printf -v quoted_bash '%q' "$(command -v bash)"
printf -v quoted_cron_path '%q' "${cron_path}"
CRON_LINE="17 3 * * * PATH=${quoted_cron_path} ENV_FILE=${quoted_env_file} ${quoted_bash} ${quoted_renew_script} >> ${quoted_log_file} 2>&1"

mkdir -p "${ROOT_DIR}/logs"

candidate_crontab="$(mktemp)"
trap 'rm -f "${candidate_crontab}"' EXIT
(
  crontab -l 2>/dev/null | grep -v -F "${RENEW_SCRIPT}" || true
  printf '%s\n' "${CRON_LINE}"
) > "${candidate_crontab}"
crontab "${candidate_crontab}"
rm -f "${candidate_crontab}"
trap - EXIT

echo "Installed daily certificate renewal cron: ${CRON_LINE}"
