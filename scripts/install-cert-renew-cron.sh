#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENEW_SCRIPT="${ROOT_DIR}/scripts/renew-cert.sh"
LOG_FILE="${ROOT_DIR}/logs/cert-renew.log"
CRON_LINE="17 3 * * * ${RENEW_SCRIPT} >> ${LOG_FILE} 2>&1"

mkdir -p "${ROOT_DIR}/logs"

(
  crontab -l 2>/dev/null | grep -v -F "${RENEW_SCRIPT}" || true
  printf '%s\n' "${CRON_LINE}"
) | crontab -

echo "Installed daily certificate renewal cron: ${CRON_LINE}"
