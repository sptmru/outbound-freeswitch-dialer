#!/usr/bin/env bash
set -euo pipefail
# Disposable Linux FS + PostgreSQL lab. Never reads .env or DATABASE_URL.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6"
PG_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
RUN_DIR="$(mktemp -d /tmp/outbound-d01.XXXXXXXX)"
FS_CONTAINER="outbound-d01-fs-$(basename "$RUN_DIR")"
PG_CONTAINER="outbound-d01-pg-$(basename "$RUN_DIR")"
NET_CONTAINER="outbound-d01-net-$(basename "$RUN_DIR")"
NODE_BIN="$(command -v node)"
cleanup() {
  result=$?
  trap - EXIT
  docker logs "$FS_CONTAINER" > "$RUN_DIR/freeswitch-container.log" 2>&1 || true
  docker logs "$PG_CONTAINER" > "$RUN_DIR/postgres.log" 2>&1 || true
  if ! docker rm -fv "$FS_CONTAINER" "$PG_CONTAINER" "$NET_CONTAINER" > "$RUN_DIR/container-cleanup.txt" 2>&1; then result=1; fi
  echo "D01 artifacts: $RUN_DIR"
  exit "$result"
}
trap cleanup EXIT
command -v nsenter >/dev/null
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
docker image inspect "$IMAGE" "$PG_IMAGE" --format '{{.Id}} {{json .RepoDigests}}' > "$RUN_DIR/images.txt"
git -C "$ROOT_DIR" rev-parse HEAD > "$RUN_DIR/base-revision.txt"
mkdir "$RUN_DIR/socket"
chmod 777 "$RUN_DIR/socket"
cd "$ROOT_DIR"
npm --workspace @outbound-dialer/shared run build
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.test.json
"$NODE_BIN" "$ROOT_DIR/scripts/d01-desk-probe.mjs" render "$RUN_DIR"
sha256sum "$ROOT_DIR"/scripts/d01-*.mjs "$ROOT_DIR"/scripts/a0{4,5}-*.mjs "$0" \
  "$ROOT_DIR"/apps/api/src/desk-sessions*.ts "$ROOT_DIR"/apps/api/src/dashboard/desk-sessions.ts \
  "$ROOT_DIR"/apps/api/src/freeswitch/provisioning.ts "$ROOT_DIR"/apps/api/src/call-admission.ts \
  "$ROOT_DIR"/apps/api/src/eligibility.ts "$ROOT_DIR"/packages/shared/src/*.ts \
  "$ROOT_DIR"/apps/api/db/migrations/*.sql "$ROOT_DIR"/tests/fixtures/inbound/cleanup.mjs > "$RUN_DIR/source-sha256.txt"
docker run -d --name "$NET_CONTAINER" --network none --memory 32m --pids-limit 8 \
  --cap-drop ALL --entrypoint sleep "$IMAGE" 3600 > "$RUN_DIR/net-id.txt"
docker run -d --name "$PG_CONTAINER" --network "container:$NET_CONTAINER" --memory 256m --pids-limit 128 \
  --mount "type=bind,src=$RUN_DIR/socket,dst=/db-socket" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=d01 "$PG_IMAGE" \
  -c unix_socket_directories=/var/run/postgresql,/db-socket -c listen_addresses= > "$RUN_DIR/pg-id.txt"
for ((i=0; i<100; i++)); do
  if docker exec "$PG_CONTAINER" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /db-socket -U postgres -d d01' >/dev/null 2>&1; then break; fi
  sleep 0.1
done
docker run -d --name "$FS_CONTAINER" --network "container:$NET_CONTAINER" --memory 512m --pids-limit 128 \
  --security-opt no-new-privileges --cap-drop ALL \
  --mount "type=bind,src=$RUN_DIR,dst=/a02" --entrypoint freeswitch "$IMAGE" \
  -nonat -nf -conf /a02 -log /a02 -db /a02 -run /a02 > "$RUN_DIR/fs-id.txt"
docker inspect "$FS_CONTAINER" "$PG_CONTAINER" "$NET_CONTAINER" --format '{{.Name}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' > "$RUN_DIR/isolation.txt"
PID="$(docker inspect "$NET_CONTAINER" --format '{{.State.Pid}}')"
timeout 300 nsenter --net="/proc/$PID/ns/net" "$NODE_BIN" "$ROOT_DIR/scripts/d01-desk-probe.mjs" probe "$RUN_DIR"
