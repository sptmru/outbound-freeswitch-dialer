#!/usr/bin/env bash
set -euo pipefail
# Disposable DB-only prototype; no .env, host ports, external traffic or product DB.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
RUN_DIR="$(mktemp -d /tmp/outbound-a06.XXXXXXXX)"
PG_CONTAINER="outbound-a06-pg-$(basename "$RUN_DIR")"
cleanup() {
  docker logs "$PG_CONTAINER" > "$RUN_DIR/postgres.log" 2>&1 || true
  docker rm -fv "$PG_CONTAINER" >/dev/null 2>&1 || true
  echo "A06 artifacts: $RUN_DIR"
}
trap cleanup EXIT
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
mkdir "$RUN_DIR/socket"
chmod 777 "$RUN_DIR/socket"
git -C "$ROOT_DIR" rev-parse HEAD > "$RUN_DIR/base-revision.txt"
sha256sum "$ROOT_DIR"/scripts/a06-*.mjs "$ROOT_DIR"/tests/a06-budgets.test.mjs "$0" > "$RUN_DIR/source-sha256.txt"
docker image inspect "$PG_IMAGE" --format '{{.Id}} {{json .RepoDigests}}' > "$RUN_DIR/image.txt"
docker run -d --name "$PG_CONTAINER" --network none --memory 512m --cpus 2 --pids-limit 128 \
  --mount "type=bind,src=$RUN_DIR/socket,dst=/db-socket" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=a06 "$PG_IMAGE" \
  -c unix_socket_directories=/var/run/postgresql,/db-socket -c listen_addresses= \
  -c max_connections=100 > "$RUN_DIR/pg-id.txt"
ready=false
for ((i=0;i<100;i++)); do
  if docker exec "$PG_CONTAINER" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /db-socket -U postgres -d a06' >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'A06 PostgreSQL not ready' >&2; exit 1; fi
docker inspect "$PG_CONTAINER" --format '{{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' > "$RUN_DIR/isolation.txt"
timeout 60 node "$ROOT_DIR/scripts/a06-budget-probe.mjs" "$RUN_DIR" > "$RUN_DIR/result.txt" 2>&1
cat "$RUN_DIR/result.txt"
