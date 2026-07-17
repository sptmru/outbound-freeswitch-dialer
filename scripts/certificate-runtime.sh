#!/usr/bin/env bash

certificate_fingerprint() {
  compose exec -T proxy sh -c '
    certificate="/etc/letsencrypt/live/${LETSENCRYPT_DOMAIN}/fullchain.pem"
    test -s "${certificate}"
    openssl x509 -in "${certificate}" -noout -fingerprint -sha256
  '
}

certificate_active_call_count() {
  compose exec -T postgres psql \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" \
    --tuples-only \
    --no-align \
    --command "select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled', 'agent_released')"
}

certificate_set_call_start_paused() {
  local paused="$1"
  if [[ "${paused}" != "true" && "${paused}" != "false" ]]; then
    echo "Invalid call-start maintenance gate value: ${paused}" >&2
    return 1
  fi
  compose exec -T postgres psql \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" \
    --set ON_ERROR_STOP=1 \
    --command "insert into system_settings (key, value_json, updated_at) values ('ops.call_start_paused', '${paused}'::jsonb, now()) on conflict (key) do update set value_json = excluded.value_json, updated_at = now()"
}

certificate_served_proxy_fingerprint() {
  compose exec -T proxy sh -c '
    openssl s_client -connect 127.0.0.1:443 -servername "${LETSENCRYPT_DOMAIN}" </dev/null 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256
  '
}

certificate_coturn_is_running() {
  local container_id
  container_id="$(compose ps --status running -q coturn)" || return 1
  [[ -n "${container_id}" ]]
}

apply_certificate_runtime_if_changed() {
  local root_dir="$1"
  local marker_file="${root_dir}/logs/applied-certificate.sha256"
  local current_fingerprint
  local applied_fingerprint=""
  local active_calls
  local served_fingerprint=""
  local marker_tmp
  local apply_status=0

  current_fingerprint="$(certificate_fingerprint)" || {
    echo "Certificate issuance completed but the full chain could not be fingerprinted" >&2
    return 1
  }
  if [[ -f "${marker_file}" ]]; then
    applied_fingerprint="$(<"${marker_file}")"
  fi
  if [[ "${current_fingerprint}" == "${applied_fingerprint}" ]]; then
    served_fingerprint="$(certificate_served_proxy_fingerprint 2>/dev/null || true)"
    if [[ "${served_fingerprint}" == "${current_fingerprint}" ]]; then
      if ! certificate_set_call_start_paused false; then
        echo "Certificate is unchanged, but the call-start maintenance gate could not be reopened" >&2
        return 1
      fi
      echo "Certificate is unchanged and the proxy serves the recorded fingerprint; runtime apply is not required"
      return 0
    fi
    echo "Certificate marker matches the current files, but the proxy fingerprint differs; reapplying runtime certificate"
  fi

  if ! certificate_set_call_start_paused true; then
    echo "Certificate files changed, but new calls could not be paused; runtime reload was not applied" >&2
    return 1
  fi

  if ! active_calls="$(certificate_active_call_count)"; then
    if [[ "${ALLOW_UNVERIFIED_CERTIFICATE_APPLY:-false}" != "true" ]]; then
      echo "Certificate files changed, but active-call state could not be verified; runtime reload was not applied" >&2
      apply_status=1
    fi
  elif [[ ! "${active_calls}" =~ ^[0-9]+$ ]]; then
    echo "Certificate files changed, but the active-call metric was invalid; runtime reload was not applied" >&2
    apply_status=1
  elif awk -v value="${active_calls}" 'BEGIN { exit !(value > 0) }' \
    && [[ "${ALLOW_ACTIVE_CALL_CERTIFICATE_APPLY:-false}" != "true" ]]; then
    echo "Certificate files changed; deferring proxy reload and Coturn recreation while ${active_calls} call(s) are active"
    if ! certificate_set_call_start_paused false; then
      echo "Certificate apply was deferred, but the call-start maintenance gate could not be reopened" >&2
      return 1
    fi
    return 0
  fi

  if [[ "${apply_status}" -eq 0 ]] \
    && ! compose exec -T proxy /docker-entrypoint.d/20-render-outbound-dialer-proxy.sh; then
    echo "Failed to render the proxy configuration for the renewed certificate" >&2
    apply_status=1
  fi
  if [[ "${apply_status}" -eq 0 ]] && ! compose exec -T proxy nginx -t; then
    echo "Renewed certificate proxy configuration failed nginx validation" >&2
    apply_status=1
  fi
  if [[ "${apply_status}" -eq 0 ]] && ! compose exec -T proxy nginx -s reload; then
    echo "Failed to reload the proxy with the renewed certificate" >&2
    apply_status=1
  fi
  if [[ "${apply_status}" -eq 0 ]] && ! compose up -d --wait --force-recreate coturn; then
    echo "Failed to recreate Coturn with the renewed certificate" >&2
    apply_status=1
  fi
  if [[ "${apply_status}" -eq 0 ]] && ! certificate_coturn_is_running; then
    echo "Coturn is not running after certificate recreation" >&2
    apply_status=1
  fi
  if [[ "${apply_status}" -eq 0 ]]; then
    served_fingerprint="$(certificate_served_proxy_fingerprint 2>/dev/null || true)"
    if [[ "${served_fingerprint}" != "${current_fingerprint}" ]]; then
      echo "Proxy does not serve the renewed certificate fingerprint; marker was not advanced" >&2
      apply_status=1
    fi
  fi

  if [[ "${apply_status}" -eq 0 ]]; then
    marker_tmp="${marker_file}.tmp.$$"
    if ! mkdir -p "$(dirname "${marker_file}")" \
      || ! printf '%s\n' "${current_fingerprint}" > "${marker_tmp}" \
      || ! chmod 600 "${marker_tmp}" \
      || ! mv "${marker_tmp}" "${marker_file}"; then
      rm -f "${marker_tmp}"
      echo "Renewed certificate was applied, but its fingerprint marker could not be persisted" >&2
      apply_status=1
    fi
  fi

  if ! certificate_set_call_start_paused false; then
    echo "Certificate workflow could not reopen the call-start maintenance gate" >&2
    return 1
  fi
  if [[ "${apply_status}" -ne 0 ]]; then
    return "${apply_status}"
  fi
  echo "Applied and verified renewed certificate for proxy and Coturn"
}
