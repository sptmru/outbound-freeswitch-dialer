#!/usr/bin/env bash
set -euo pipefail
# Disposable product-entrypoint FS + PostgreSQL. Never reads .env or app DB.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6"
PG_IMAGE="postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"
RUN_DIR="$(mktemp -d /tmp/outbound-d03.XXXXXXXX)"
FS_CONTAINER="outbound-d03-fs-$(basename "$RUN_DIR")"
PG_CONTAINER="outbound-d03-pg-$(basename "$RUN_DIR")"
NET_CONTAINER="outbound-d03-net-$(basename "$RUN_DIR")"
NODE_BIN="$(command -v node)"
cleanup() {
  result=$?
  trap - EXIT
  if [[ -f "$RUN_DIR/journal-agent.pid" ]]; then
    read -r JOURNAL_PID < "$RUN_DIR/journal-agent.pid" || true
    if [[ "$JOURNAL_PID" =~ ^[0-9]+$ ]] && [[ -r "/proc/$JOURNAL_PID/environ" ]] && \
      tr '\0' '\n' < "/proc/$JOURNAL_PID/environ" | grep -Fxq "FREESWITCH_INGRESS_SOCKET=$RUN_DIR/agent.sock"; then
      kill -CONT "$JOURNAL_PID" 2>/dev/null || true
      kill -TERM "$JOURNAL_PID" 2>/dev/null || true
    fi
  fi
  docker logs "$FS_CONTAINER" > "$RUN_DIR/freeswitch-container.log" 2>&1 || true
  docker logs "$PG_CONTAINER" > "$RUN_DIR/postgres.log" 2>&1 || true
  if ! docker rm -fv "$FS_CONTAINER" "$PG_CONTAINER" "$NET_CONTAINER" > "$RUN_DIR/container-cleanup.txt" 2>&1; then result=1; fi
  echo "D03 artifacts: $RUN_DIR"
  exit "$result"
}
trap cleanup EXIT
cd "$ROOT_DIR"
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
npm --workspace @outbound-dialer/shared run build
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.test.json
mkdir "$RUN_DIR/socket"
chmod 777 "$RUN_DIR/socket"
git rev-parse HEAD > "$RUN_DIR/base-revision.txt"
sha256sum apps/api/src/freeswitch/*.ts infra/freeswitch/entrypoint.sh infra/freeswitch/templates/inbound/* apps/api/src/ingress-*.ts apps/api/src/inbound-ingress*.ts \
  apps/api/db/migrations/*.sql scripts/d03-ingress-probe.mjs scripts/d03-import-worker.mjs tests/fixtures/inbound/cleanup.mjs "$0" > "$RUN_DIR/source-sha256.txt"
docker image inspect "$IMAGE" "$PG_IMAGE" --format '{{.Id}} {{json .RepoDigests}}' > "$RUN_DIR/images.txt"
docker run -d --name "$NET_CONTAINER" --network none --memory 32m --pids-limit 8 \
  --cap-drop ALL --entrypoint sleep "$IMAGE" 3600 > "$RUN_DIR/net-id.txt"
docker run -d --name "$PG_CONTAINER" --network "container:$NET_CONTAINER" --memory 256m --pids-limit 128 \
  --mount "type=bind,src=$RUN_DIR/socket,dst=/db-socket" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=d03 "$PG_IMAGE" \
  -c unix_socket_directories=/var/run/postgresql,/db-socket -c listen_addresses= > "$RUN_DIR/pg-id.txt"
for ((i=0;i<100;i++)); do
  if docker exec "$PG_CONTAINER" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /db-socket -U postgres -d d03' >/dev/null 2>&1; then break; fi
  sleep 0.1
done
docker run -d --name "$FS_CONTAINER" --network "container:$NET_CONTAINER" --memory 768m --pids-limit 256 \
  --security-opt no-new-privileges --cap-drop ALL \
  --mount "type=bind,src=$RUN_DIR,dst=/a02" --mount "type=bind,src=$ROOT_DIR/infra/freeswitch,dst=/repo,readonly" \
  -e TEMPLATE_DIR=/repo/templates -e FREESWITCH_CONFIG_DIR=/a02/conf \
  -e FREESWITCH_GENERATED_CONFIG_DIR=/a02/generated -e FREESWITCH_LOG_DIR=/a02/log -e FREESWITCH_DB_DIR=/a02/db \
  -e FREESWITCH_ESL_PASSWORD=a02-disposable-only -e FREESWITCH_ESL_ACL=loopback.auto \
  -e FREESWITCH_DOMAIN=a04.invalid -e FREESWITCH_RTP_START_PORT=20000 -e FREESWITCH_RTP_END_PORT=20040 \
  -e FREESWITCH_EXTERNAL_SIP_IP=127.0.0.1 -e FREESWITCH_EXTERNAL_RTP_IP=127.0.0.1 \
  -e FREESWITCH_INTERNAL_SIP_PORT=5080 -e FREESWITCH_EXTERNAL_PROFILE_SIP_PORT=5090 \
  -e FREESWITCH_EXTERNAL_PROFILE_TLS_PORT=5091 -e FREESWITCH_WEBRTC_WSS_PORT=7443 \
  -e FREESWITCH_INGRESS_ENABLED=true -e FREESWITCH_INBOUND_CONFIG_ENABLED=true -e SIP_TRUNK_MODE=ip_auth \
  --entrypoint sh "$IMAGE" -c 'if [ ! -d /a02/conf ]; then cp -a /usr/share/freeswitch/conf/vanilla /a02/conf; fi; exec sh /repo/entrypoint.sh' > "$RUN_DIR/fs-id.txt"
docker inspect "$FS_CONTAINER" "$PG_CONTAINER" "$NET_CONTAINER" --format '{{.Name}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' > "$RUN_DIR/isolation.txt"
PID="$(docker inspect "$NET_CONTAINER" --format '{{.State.Pid}}')"
D03_PG_CONTAINER="$PG_CONTAINER" D03_FS_CONTAINER="$FS_CONTAINER" timeout 300 nsenter --net="/proc/$PID/ns/net" "$NODE_BIN" scripts/d03-ingress-probe.mjs "$RUN_DIR"
