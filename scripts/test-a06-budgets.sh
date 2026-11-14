#!/usr/bin/env bash
set -euo pipefail
# Disposable DB-only prototype; no .env, host ports, external traffic or product DB.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
PG_STORAGE="${A06_PG_STORAGE:-tmpfs}"
case "$PG_STORAGE" in
  tmpfs) STORAGE_ARGS=(--tmpfs /var/lib/postgresql/data:rw,size=256m) ;;
  volume) STORAGE_ARGS=() ;;
  *) echo 'A06_PG_STORAGE must be tmpfs or volume' >&2; exit 1 ;;
esac
RUN_DIR="$(mktemp -d /tmp/outbound-a06.XXXXXXXX)"
PG_CONTAINER="outbound-a06-pg-$(basename "$RUN_DIR")"
created=false
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$created" == true ]]; then
    docker logs "$PG_CONTAINER" > "$RUN_DIR/postgres.log" 2>&1 || true
    if ! docker rm -fv "$PG_CONTAINER" > "$RUN_DIR/container-cleanup.txt" 2>&1; then result=1; fi
  fi
  echo "A06 artifacts: $RUN_DIR"
  exit "$result"
}
trap cleanup EXIT
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
mkdir "$RUN_DIR/socket"
chmod 777 "$RUN_DIR/socket"
git -C "$ROOT_DIR" rev-parse HEAD > "$RUN_DIR/base-revision.txt"
sha256sum "$ROOT_DIR"/scripts/a06-*.mjs "$ROOT_DIR"/tests/a06-*.test.mjs "$0" > "$RUN_DIR/source-sha256.txt"
docker image inspect "$PG_IMAGE" --format '{{.Id}} {{json .RepoDigests}}' > "$RUN_DIR/image.txt"
docker run -d --name "$PG_CONTAINER" --network none --memory 512m --cpus 2 --pids-limit 128 \
  "${STORAGE_ARGS[@]}" \
  --mount "type=bind,src=$RUN_DIR/socket,dst=/db-socket" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=a06 "$PG_IMAGE" \
  -c unix_socket_directories=/var/run/postgresql,/db-socket -c listen_addresses= \
  -c max_connections=100 -c fsync=on -c synchronous_commit=on -c track_wal_io_timing=on > "$RUN_DIR/pg-id.txt"
created=true
ready=false
for ((i=0;i<100;i++)); do
  if docker exec "$PG_CONTAINER" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /db-socket -U postgres -d a06' >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'A06 PostgreSQL not ready' >&2; exit 1; fi
docker inspect "$PG_CONTAINER" --format '{{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{json (index .HostConfig "Tmpfs")}}' > "$RUN_DIR/isolation.txt"
printf '%s\n' "$PG_STORAGE" > "$RUN_DIR/storage.txt"
timeout 60 node "$ROOT_DIR/scripts/a06-budget-probe.mjs" "$RUN_DIR" > "$RUN_DIR/result.txt" 2>&1 || { cat "$RUN_DIR/result.txt"; exit 1; }
cat "$RUN_DIR/result.txt"
