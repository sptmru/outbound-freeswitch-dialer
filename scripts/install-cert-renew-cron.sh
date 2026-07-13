#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
RENEW_SCRIPT="${ROOT_DIR}/scripts/renew-cert.sh"
LOG_FILE="${ROOT_DIR}/logs/cert-renew.log"
[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }
command -v crontab >/dev/null || { echo "Missing required command: crontab" >&2; exit 1; }
ENV_FILE="$(cd "$(dirname "${ENV_FILE}")" && pwd)/$(basename "${ENV_FILE}")"
printf -v quoted_env_file '%q' "${ENV_FILE}"
printf -v quoted_renew_script '%q' "${RENEW_SCRIPT}"
printf -v quoted_log_file '%q' "${LOG_FILE}"
CRON_LINE="17 3 * * * ENV_FILE=${quoted_env_file} ${quoted_renew_script} >> ${quoted_log_file} 2>&1"

mkdir -p "${ROOT_DIR}/logs"

(
  crontab -l 2>/dev/null | grep -v -F "${RENEW_SCRIPT}" || true
  printf '%s\n' "${CRON_LINE}"
) | crontab -

echo "Installed daily certificate renewal cron: ${CRON_LINE}"
