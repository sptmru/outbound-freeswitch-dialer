#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_socket="$(mktemp -d /tmp/outbound-voicemail-test-XXXXXX)"
fixture_container=""
cleanup() {
  if [[ -n "$fixture_container" ]]; then docker rm -f "$fixture_container" >/dev/null 2>&1 || true; fi
  rm -rf -- "$fixture_socket"
}
trap cleanup EXIT
chmod 777 "$fixture_socket"
fixture_container="$(docker run --rm -d --network none --tmpfs /var/lib/postgresql/data \
  --mount "type=bind,src=$fixture_socket,dst=/db-socket" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=voicemail_test postgres:16-alpine \
  -c unix_socket_directories=/var/run/postgresql,/db-socket -c listen_addresses=)"
fixture_ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "$fixture_container" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /db-socket -U postgres -d voicemail_test' >/dev/null 2>&1; then
    fixture_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$fixture_ready" != true ]]; then echo 'Isolated PostgreSQL fixture did not become ready' >&2; exit 1; fi
npm --workspace @outbound-dialer/shared run build
(cd apps/api && npx tsc -p tsconfig.test.json)
VOICEMAIL_TEST_PG_SOCKET="$fixture_socket" node --test apps/api/dist-test/dashboard/campaign-voicemail.integration.test.js
