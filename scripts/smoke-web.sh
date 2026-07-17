#!/usr/bin/env bash
set -euo pipefail

WEB_SMOKE_URL="${WEB_SMOKE_URL:-http://127.0.0.1:${WEB_PUBLIC_PORT:-8080}}"
WEB_SMOKE_CURL_TIMEOUT_SECONDS="${WEB_SMOKE_CURL_TIMEOUT_SECONDS:-5}"
WEB_SMOKE_RETRY_ATTEMPTS="${WEB_SMOKE_RETRY_ATTEMPTS:-10}"
WEB_SMOKE_RETRY_DELAY_SECONDS="${WEB_SMOKE_RETRY_DELAY_SECONDS:-1}"

[[ "${WEB_SMOKE_RETRY_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] \
  || { echo "WEB_SMOKE_RETRY_ATTEMPTS must be a positive integer" >&2; exit 1; }
[[ "${WEB_SMOKE_RETRY_DELAY_SECONDS}" =~ ^[0-9]+$ ]] \
  || { echo "WEB_SMOKE_RETRY_DELAY_SECONDS must be a non-negative integer" >&2; exit 1; }

base_url="${WEB_SMOKE_URL%/}"

fetch() {
  local path="$1"
  local attempt
  local curl_error_file
  local response

  curl_error_file="$(mktemp)"
  for ((attempt = 1; attempt <= WEB_SMOKE_RETRY_ATTEMPTS; attempt += 1)); do
    if response="$(curl -fsS --max-time "${WEB_SMOKE_CURL_TIMEOUT_SECONDS}" "${base_url}${path}" 2>"${curl_error_file}")"; then
      rm -f "${curl_error_file}"
      printf '%s' "${response}"
      return 0
    fi

    if ((attempt < WEB_SMOKE_RETRY_ATTEMPTS)); then
      sleep "${WEB_SMOKE_RETRY_DELAY_SECONDS}"
    fi
  done

  cat "${curl_error_file}" >&2
  rm -f "${curl_error_file}"
  echo "Web smoke request failed after ${WEB_SMOKE_RETRY_ATTEMPTS} attempt(s): ${base_url}${path}" >&2
  return 1
}

index_html="$(fetch "/")"
if [[ "${index_html}" != *'<div id="root">'* || "${index_html}" != *"/assets/index-"* ]]; then
  echo "Web root did not return the built SPA shell from ${base_url}/" >&2
  exit 1
fi

health_json="$(fetch "/api/health/ready")"
if [[ "${health_json}" != *'"status":"ok"'* \
  || "${health_json}" != *'"service":"api"'* \
  || "${health_json}" != *'"checks"'* ]]; then
  echo "Web /api proxy did not return ready API health JSON from ${base_url}/api/health/ready" >&2
  exit 1
fi

echo "Published web smoke passed: ${base_url}/ and ${base_url}/api/health/ready"
