#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${ROOT_DIR}/infra/docker/docker-compose.yml"

[[ -f "${ENV_FILE}" ]] || { echo "Missing ${ENV_FILE}" >&2; exit 1; }

compose() {
  APP_ENV_FILE="${ENV_FILE}" docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

default_services="postgres api web proxy coturn freeswitch pcap-capture prometheus alertmanager grafana node-exporter cadvisor postgres-exporter blackbox-exporter loki docker-socket-proxy alloy"
read -r -a required_services <<< "${default_services}"
[[ "${#required_services[@]}" -gt 0 ]] || { echo "No mandatory runtime services configured" >&2; exit 1; }

for service in "${required_services[@]}"; do
  container_ids="$(compose ps -q "${service}")"
  [[ -n "${container_ids}" ]] || {
    echo "Mandatory runtime service ${service} has no container" >&2
    exit 1
  }

  while IFS= read -r container_id; do
    [[ -n "${container_id}" ]] || continue
    status="$(docker inspect --format '{{.State.Status}}' "${container_id}")"
    [[ "${status}" == "running" ]] || {
      echo "Mandatory runtime service ${service} is ${status}, not running" >&2
      exit 1
    }
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}")"
    case "${health}" in
      healthy | none) ;;
      *)
        echo "Mandatory runtime service ${service} health is ${health}" >&2
        exit 1
        ;;
    esac
  done <<< "${container_ids}"
done

echo "Mandatory runtime services are running and all configured health checks are healthy"
