#!/usr/bin/env sh
set -eu

required() {
  name="$1"
  eval "value=\${${name}:-}"
  if [ -z "${value}" ]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

for name in TURN_REALM TURN_SHARED_SECRET TURN_EXTERNAL_IP TURN_RELAY_IP TURN_MIN_PORT TURN_MAX_PORT; do
  required "${name}"
done

case "${TURN_MIN_PORT}:${TURN_MAX_PORT}" in
  *[!0-9:]*|:|*:)
    echo "TURN_MIN_PORT and TURN_MAX_PORT must be numeric" >&2
    exit 1
    ;;
esac

if [ "${TURN_MIN_PORT}" -gt "${TURN_MAX_PORT}" ]; then
  echo "TURN_MIN_PORT must not exceed TURN_MAX_PORT" >&2
  exit 1
fi

config=/tmp/turnserver.conf
umask 077
{
  echo "listening-port=${TURN_PORT:-3478}"
  echo "tls-listening-port=${TURN_TLS_PORT:-5349}"
  echo "listening-ip=${TURN_RELAY_IP}"
  echo "relay-ip=${TURN_RELAY_IP}"
  echo "external-ip=${TURN_EXTERNAL_IP}/${TURN_RELAY_IP}"
  echo "min-port=${TURN_MIN_PORT}"
  echo "max-port=${TURN_MAX_PORT}"
  echo "realm=${TURN_REALM}"
  echo "server-name=${TURN_REALM}"
  echo "use-auth-secret"
  echo "static-auth-secret=${TURN_SHARED_SECRET}"
  echo "fingerprint"
  echo "stale-nonce=600"
  echo "user-quota=${TURN_USER_QUOTA:-4}"
  echo "total-quota=${TURN_TOTAL_QUOTA:-200}"
  echo "no-multicast-peers"
  echo "unauthorized-ratelimit"
  echo "denied-peer-ip=10.0.0.0-10.255.255.255"
  echo "denied-peer-ip=172.16.0.0-172.31.255.255"
  echo "denied-peer-ip=192.168.0.0-192.168.255.255"
  echo "allowed-peer-ip=${TURN_RELAY_IP}"
  echo "pidfile=/tmp/turnserver.pid"
  echo "log-file=/dev/stdout"
  echo "simple-log"

  certificate_dir="/etc/letsencrypt/live/${TURN_REALM}"
  if [ -r "${certificate_dir}/fullchain.pem" ] && [ -r "${certificate_dir}/privkey.pem" ]; then
    echo "cert=${certificate_dir}/fullchain.pem"
    echo "pkey=${certificate_dir}/privkey.pem"
  else
    echo "Coturn TLS certificate is not available yet; TLS listener will be enabled after certificate reconciliation." >&2
    echo "no-tls"
    echo "no-dtls"
  fi
} > "${config}"

exec turnserver -c "${config}"
