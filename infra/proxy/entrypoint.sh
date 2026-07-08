#!/usr/bin/env sh
set -eu

domain="${LETSENCRYPT_DOMAIN:-localhost}"
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

envsubst '${LETSENCRYPT_DOMAIN} ${OUTBOUND_DIALER_SSL_CERTIFICATE} ${OUTBOUND_DIALER_SSL_CERTIFICATE_KEY} ${FREESWITCH_WS_UPSTREAM}' \
  < /etc/nginx/templates/outbound-dialer.conf.tpl \
  > /etc/nginx/conf.d/default.conf
