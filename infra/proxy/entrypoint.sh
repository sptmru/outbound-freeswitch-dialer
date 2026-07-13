#!/usr/bin/env sh
set -eu

proxy_max_request_body_size="${PROXY_MAX_REQUEST_BODY_SIZE:-70m}"

if ! printf '%s\n' "${proxy_max_request_body_size}" | grep -Eq '^[1-9][0-9]*[kKmMgG]?$'; then
  echo "Invalid PROXY_MAX_REQUEST_BODY_SIZE: expected a positive integer with an optional k, m, or g suffix." >&2
  exit 1
fi

export PROXY_MAX_REQUEST_BODY_SIZE="${proxy_max_request_body_size}"

if [ "${OUTBOUND_DIALER_PROXY_VALIDATE_ONLY:-false}" = "true" ]; then
  exit 0
fi

domain="${LETSENCRYPT_DOMAIN:-localhost}"
grafana_domain="${GRAFANA_DOMAIN:-grafana.localhost}"
upstream_tls_verify="${FREESWITCH_WS_UPSTREAM_TLS_VERIFY:-on}"
upstream_tls_server_name="${FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME:-${domain}}"
if [ "${upstream_tls_verify}" != "on" ] && [ "${upstream_tls_verify}" != "off" ]; then
  echo "FREESWITCH_WS_UPSTREAM_TLS_VERIFY must be on or off" >&2
  exit 1
fi
if ! printf '%s\n' "${upstream_tls_server_name}" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  echo "FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME must be a DNS name" >&2
  exit 1
fi
real_cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
real_key="/etc/letsencrypt/live/${domain}/privkey.pem"
fallback_dir="/etc/nginx/fallback-certs"
fallback_cert="${fallback_dir}/fullchain.pem"
fallback_key="${fallback_dir}/privkey.pem"

mkdir -p "${fallback_dir}"

if [ ! -f "${fallback_cert}" ] || [ ! -f "${fallback_key}" ]; then
  openssl req \
    -x509 \
    -nodes \
    -newkey rsa:2048 \
    -days 2 \
    -subj "/CN=${domain}" \
    -keyout "${fallback_key}" \
    -out "${fallback_cert}" >/dev/null 2>&1
fi

if [ -f "${real_cert}" ] && [ -f "${real_key}" ]; then
  export OUTBOUND_DIALER_SSL_CERTIFICATE="${real_cert}"
  export OUTBOUND_DIALER_SSL_CERTIFICATE_KEY="${real_key}"
else
  export OUTBOUND_DIALER_SSL_CERTIFICATE="${fallback_cert}"
  export OUTBOUND_DIALER_SSL_CERTIFICATE_KEY="${fallback_key}"
fi

export FREESWITCH_WS_UPSTREAM_SCHEME="${FREESWITCH_WS_UPSTREAM_SCHEME:-http}"
export FREESWITCH_WS_UPSTREAM_TLS_VERIFY="${upstream_tls_verify}"
export FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME="${upstream_tls_server_name}"
export GRAFANA_DOMAIN="${grafana_domain}"

envsubst '${LETSENCRYPT_DOMAIN} ${GRAFANA_DOMAIN} ${OUTBOUND_DIALER_SSL_CERTIFICATE} ${OUTBOUND_DIALER_SSL_CERTIFICATE_KEY} ${FREESWITCH_WS_UPSTREAM} ${FREESWITCH_WS_UPSTREAM_SCHEME} ${FREESWITCH_WS_UPSTREAM_TLS_VERIFY} ${FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME} ${PROXY_MAX_REQUEST_BODY_SIZE}' \
  < /etc/nginx/templates/outbound-dialer.conf.tpl \
  > /etc/nginx/conf.d/default.conf
