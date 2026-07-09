#!/usr/bin/env bash
set -euo pipefail

WEB_SMOKE_URL="${WEB_SMOKE_URL:-http://127.0.0.1:${WEB_PUBLIC_PORT:-8080}}"
WEB_SMOKE_CURL_TIMEOUT_SECONDS="${WEB_SMOKE_CURL_TIMEOUT_SECONDS:-5}"

base_url="${WEB_SMOKE_URL%/}"

fetch() {
  local path="$1"
  curl -fsS --max-time "${WEB_SMOKE_CURL_TIMEOUT_SECONDS}" "${base_url}${path}"
}

index_html="$(fetch "/")"
if [[ "${index_html}" != *'<div id="root">'* || "${index_html}" != *"/assets/index-"* ]]; then
  echo "Web root did not return the built SPA shell from ${base_url}/" >&2
  exit 1
fi

health_json="$(fetch "/api/health")"
if [[ "${health_json}" != *'"service":"api"'* || "${health_json}" != *'"checks"'* ]]; then
  echo "Web /api proxy did not return API health JSON from ${base_url}/api/health" >&2
  exit 1
fi

echo "Published web smoke passed: ${base_url}/ and ${base_url}/api/health"
