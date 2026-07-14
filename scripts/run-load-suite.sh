#!/usr/bin/env bash
set -euo pipefail

LOAD_BASE_URL="${LOAD_BASE_URL:-}"
LOAD_AUTH_TOKENS_FILE="${LOAD_AUTH_TOKENS_FILE:-}"
LOAD_SUITE="${LOAD_SUITE:-smoke}"
LOAD_ARTIFACT_DIR="${LOAD_ARTIFACT_DIR:-logs/load-tests/$(date -u +%Y%m%dT%H%M%SZ)}"

[[ -n "${LOAD_BASE_URL}" ]] || { echo "Set LOAD_BASE_URL (include /api for the public deployment)" >&2; exit 1; }
[[ -n "${LOAD_AUTH_TOKENS_FILE}" && -f "${LOAD_AUTH_TOKENS_FILE}" ]] \
  || { echo "Set LOAD_AUTH_TOKENS_FILE to a file containing one dedicated test-agent JWT per line" >&2; exit 1; }
[[ "${LOAD_SUITE}" =~ ^(smoke|capacity|soak)$ ]] || { echo "LOAD_SUITE must be smoke, capacity, or soak" >&2; exit 1; }

case "${LOAD_BASE_URL}" in
  http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*) ;;
  *)
    [[ "${LOAD_APPROVED_TARGET:-}" = "${LOAD_BASE_URL}" ]] || {
      echo "Remote target safety check failed. Set LOAD_APPROVED_TARGET exactly to ${LOAD_BASE_URL}" >&2
      exit 1
    }
    ;;
esac

mkdir -p "${LOAD_ARTIFACT_DIR}"
chmod 700 "${LOAD_ARTIFACT_DIR}"

run_stage() {
  local name="$1"
  local concurrency="$2"
  local duration="$3"
  echo "Running ${name}: ${concurrency} virtual agents for ${duration}s"
  LOAD_PROFILE=steady \
  LOAD_CONCURRENCY="${concurrency}" \
  LOAD_SSE_CONNECTIONS="${concurrency}" \
  LOAD_DURATION_SECONDS="${duration}" \
  LOAD_REPORT_PATH="${LOAD_ARTIFACT_DIR}/${name}.json" \
  node scripts/load-agent-desk.mjs
}

case "${LOAD_SUITE}" in
  smoke)
    run_stage smoke-2-agents 2 "${LOAD_SMOKE_DURATION_SECONDS:-30}"
    ;;
  capacity)
    run_stage baseline-1-agent 1 "${LOAD_BASELINE_DURATION_SECONDS:-60}"
    run_stage step-5-agents 5 "${LOAD_STEP_DURATION_SECONDS:-120}"
    run_stage step-10-agents 10 "${LOAD_STEP_DURATION_SECONDS:-120}"
    run_stage step-25-agents 25 "${LOAD_STEP_DURATION_SECONDS:-120}"
    run_stage step-50-agents 50 "${LOAD_STEP_DURATION_SECONDS:-120}"
    ;;
  soak)
    run_stage "soak-${LOAD_SOAK_CONCURRENCY:-25}-agents" "${LOAD_SOAK_CONCURRENCY:-25}" "${LOAD_SOAK_DURATION_SECONDS:-14400}"
    ;;
esac

echo "Load suite passed. Reports: ${LOAD_ARTIFACT_DIR}"
