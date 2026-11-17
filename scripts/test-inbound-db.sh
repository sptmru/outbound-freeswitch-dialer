#!/usr/bin/env bash
set -euo pipefail
# Creates its own database. No .env, published ports, application DB or external calls.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
PG_STORAGE="${INBOUND_PG_STORAGE:-volume}"
storage_args=()
case "$PG_STORAGE" in
  volume) ;;
  tmpfs) storage_args=(--tmpfs /var/lib/postgresql/data:rw,size=256m,mode=0700) ;;
  *) echo 'INBOUND_PG_STORAGE must be volume or tmpfs' >&2; exit 1 ;;
esac
PG_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
RUN_DIR="$(mktemp -d /tmp/outbound-inbound-db.XXXXXXXX)"
PG_CONTAINER="outbound-inbound-db-$(basename "$RUN_DIR")"
created=false
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$created" == true ]]; then
    docker logs "$PG_CONTAINER" > "$RUN_DIR/postgres.log" 2>&1 || true
    if ! docker rm -fv "$PG_CONTAINER" > "$RUN_DIR/container-cleanup.txt" 2>&1; then result=1; fi
  fi
  echo "Inbound DB artifacts: $RUN_DIR"
  exit "$result"
}
trap cleanup EXIT
mkdir "$RUN_DIR/socket"
chmod 777 "$RUN_DIR/socket"
git rev-parse HEAD > "$RUN_DIR/base-revision.txt"
printf '%s\n' "$PG_STORAGE" > "$RUN_DIR/storage.txt"
sha256sum apps/api/src/transfer-offers*.ts apps/api/src/dashboard/transfers.ts apps/api/src/esl.ts apps/api/src/service-invite*.ts apps/api/src/dashboard/service-invites.ts apps/api/src/freeswitch/*.ts infra/freeswitch/templates/inbound/* apps/api/src/desk-sessions*.ts apps/api/src/dashboard/desk-sessions.ts apps/api/src/supervisor-coordination*.ts apps/api/src/eligibility*.ts apps/api/src/dashboard/supervisor*.ts apps/api/src/agent-registrations*.ts apps/api/src/auth/routes.ts tests/fixtures/inbound/* apps/api/src/inbound*.ts apps/api/src/agent-call-slots*.ts apps/api/src/call-offer-expiry.ts apps/api/src/dashboard/call-offers.ts apps/api/src/call-admission*.ts apps/api/src/native-call-control*.ts apps/api/src/call-cleanup*.ts apps/api/src/call-finalization*.ts apps/api/src/call-outcomes.ts apps/api/src/agent-availability*.ts apps/api/src/esl-events*.ts apps/api/src/call-capacity*.ts apps/api/src/call-control-pools*.ts apps/api/src/manual-outbound*.ts apps/api/src/auto-next*.ts apps/api/src/call-executor*.ts apps/api/src/call-command-transport*.ts apps/api/src/desk-slots-schema.integration.test.ts apps/api/src/call-participation*.ts apps/api/src/durable-call-work*.ts apps/api/src/call-coordination*.ts apps/api/src/dashboard/calls.ts apps/api/src/dashboard/routes.ts apps/api/src/dashboard/inbound-admin.ts packages/shared/src/*.ts apps/api/src/call-observability.ts apps/api/src/dashboard/browser-media.ts apps/api/src/dashboard/recordings.ts apps/api/src/dashboard/media-tickets.ts apps/api/src/dashboard/phone.ts apps/api/db/migrations/*.sql scripts/*inbound-db* > "$RUN_DIR/source-sha256.txt"
docker image inspect "$PG_IMAGE" --format '{{.Id}} {{json .RepoDigests}}' > "$RUN_DIR/image.txt"
docker run -d --name "$PG_CONTAINER" --network none --memory 512m --cpus 2 --pids-limit 128 \
  "${storage_args[@]}" \
  --mount "type=bind,src=$RUN_DIR/socket,dst=/db-socket" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=inbound_test "$PG_IMAGE" \
  -c unix_socket_directories=/var/run/postgresql,/db-socket -c listen_addresses= \
  -c max_wal_size=64MB -c min_wal_size=32MB > "$RUN_DIR/pg-id.txt"
created=true
ready=false
for ((i=0;i<100;i++)); do
  if docker exec "$PG_CONTAINER" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /db-socket -U postgres -d inbound_test' >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'Isolated inbound PostgreSQL not ready' >&2; exit 1; fi
docker inspect "$PG_CONTAINER" --format '{{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' > "$RUN_DIR/isolation.txt"
export TEST_DATABASE_URL="postgresql://postgres@localhost/inbound_test?host=$RUN_DIR/socket"
unset DATABASE_URL
export INBOUND_TEST_ARTIFACTS="$RUN_DIR"
timeout 600 npm run test:inbound:db > "$RUN_DIR/result.txt" 2>&1 || { cat "$RUN_DIR/result.txt"; exit 1; }
cat "$RUN_DIR/result.txt"
