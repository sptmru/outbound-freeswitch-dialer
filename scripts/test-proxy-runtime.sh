#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="outbound-dialer-proxy-runtime-test:$$"
NETWORK="outbound-dialer-proxy-runtime-test-$$"
UPSTREAM_CONTAINER="outbound-dialer-proxy-upstream-$$"
PROXY_CONTAINER="outbound-dialer-proxy-runtime-$$"
RUNTIME_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "${PROXY_CONTAINER}" "${UPSTREAM_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  docker image rm "${IMAGE}" >/dev/null 2>&1 || true
  rm -rf -- "${RUNTIME_DIR}"
}
trap cleanup EXIT

mkdir -p "${RUNTIME_DIR}/certbot" "${RUNTIME_DIR}/letsencrypt"
docker build --file "${ROOT_DIR}/infra/proxy/Dockerfile" --tag "${IMAGE}" "${ROOT_DIR}"
docker network create "${NETWORK}" >/dev/null

docker run --detach \
  --name "${UPSTREAM_CONTAINER}" \
  --network "${NETWORK}" \
  --network-alias api \
  --network-alias grafana \
  --network-alias web \
  --entrypoint /bin/sh \
  "${IMAGE}" \
  -c 'printf "%s\n" "events {}" "http { server { listen 80; location / { return 200 '\''proxy-runtime-ok\\n'\''; } } }" > /tmp/upstream.conf && exec nginx -c /tmp/upstream.conf -g "daemon off;"' \
  >/dev/null

if [[ "$(docker inspect --format '{{.State.Running}}' "${UPSTREAM_CONTAINER}" 2>/dev/null || true)" != "true" ]]; then
  docker logs "${UPSTREAM_CONTAINER}" >&2 || true
  echo "Proxy runtime test upstream did not start" >&2
  exit 1
fi

docker run --detach \
  --name "${PROXY_CONTAINER}" \
  --network "${NETWORK}" \
  --init \
  --read-only \
  --pids-limit 128 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=5 \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add NET_BIND_SERVICE \
  --cap-add SETGID \
  --cap-add SETUID \
  --security-opt no-new-privileges:true \
  --tmpfs /etc/nginx/conf.d:rw,noexec,nosuid,size=1m \
  --tmpfs /etc/nginx/fallback-certs:rw,noexec,nosuid,size=1m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --tmpfs /var/cache/nginx:rw,noexec,nosuid,size=32m \
  --tmpfs /var/run:rw,noexec,nosuid,size=1m \
  --mount "type=bind,src=${RUNTIME_DIR}/letsencrypt,dst=/etc/letsencrypt,readonly" \
  --mount "type=bind,src=${RUNTIME_DIR}/certbot,dst=/var/www/certbot,readonly" \
  --env LETSENCRYPT_DOMAIN=dialer.test \
  --env GRAFANA_DOMAIN=grafana.test \
  --env FREESWITCH_WS_UPSTREAM=web:80 \
  --env FREESWITCH_WS_UPSTREAM_SCHEME=http \
  --env FREESWITCH_WS_UPSTREAM_TLS_VERIFY=off \
  --health-cmd 'wget -qO- --no-check-certificate https://127.0.0.1/ >/dev/null' \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 15 \
  "${IMAGE}" \
  >/dev/null

healthy=false
for _ in {1..30}; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${PROXY_CONTAINER}" 2>/dev/null || true)"
  if [[ "${health}" == "healthy" ]]; then
    healthy=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${PROXY_CONTAINER}" 2>/dev/null || true)" != "true" ]]; then
    break
  fi
  sleep 1
done

if [[ "${healthy}" != "true" ]]; then
  docker logs "${PROXY_CONTAINER}" >&2 || true
  echo "Hardened proxy container did not become healthy" >&2
  exit 1
fi

docker exec "${PROXY_CONTAINER}" nginx -t
response="$(docker exec "${PROXY_CONTAINER}" wget -qO- --no-check-certificate https://127.0.0.1/)"
[[ "${response}" == *"proxy-runtime-ok"* ]] || {
  echo "Hardened proxy health request did not reach the expected upstream" >&2
  exit 1
}

echo "Hardened proxy runtime test passed without publishing host ports"
