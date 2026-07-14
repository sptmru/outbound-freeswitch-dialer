#!/usr/bin/env bash
set -euo pipefail

template=/etc/outbound-dialer/fail2ban/freeswitch.conf.template
rendered=/data/jail.d/freeswitch.conf
ignore_ips="${FAIL2BAN_IGNORE_IPS:-}"

if [[ -z "${ignore_ips}" ]]; then
  echo "FAIL2BAN_IGNORE_IPS must include loopback and the trusted Compose network CIDR" >&2
  exit 1
fi
if [[ "${ignore_ips}" == *$'\n'* || "${ignore_ips}" == *$'\r'* || ! "${ignore_ips}" =~ ^[A-Za-z0-9_.,:/\ -]+$ ]]; then
  echo "FAIL2BAN_IGNORE_IPS contains unsupported characters" >&2
  exit 1
fi
if [[ "${ignore_ips}" == *"0.0.0.0/0"* || "${ignore_ips}" == *"::/0"* ]]; then
  echo "FAIL2BAN_IGNORE_IPS must not trust every address" >&2
  exit 1
fi

mkdir -p "$(dirname "${rendered}")"
sed "s|__FAIL2BAN_IGNORE_IPS__|${ignore_ips}|" "${template}" > "${rendered}"
exec /entrypoint.sh "$@"
