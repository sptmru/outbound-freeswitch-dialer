#!/usr/bin/env bash
set -euo pipefail

# Linux-only disposable FS lab. No .env, product Compose, host ports or provider.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6"
RUN_DIR="$(mktemp -d /tmp/outbound-a02.XXXXXXXX)"
CONTAINER="outbound-a02-$(basename "$RUN_DIR")"
NODE_BIN="$(command -v node)"

cleanup() {
  docker logs "$CONTAINER" > "$RUN_DIR/container.log" 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "A02 artifacts: $RUN_DIR"
}
trap cleanup EXIT

command -v nsenter >/dev/null
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
docker image inspect "$IMAGE" --format '{{.Id}} {{.Architecture}} {{json .RepoDigests}}' > "$RUN_DIR/image.txt"
git -C "$ROOT_DIR" rev-parse HEAD > "$RUN_DIR/base-revision.txt"
git -C "$ROOT_DIR" diff --binary > "$RUN_DIR/tracked.patch"
sha256sum "$ROOT_DIR/infra/freeswitch/prototypes/a02/freeswitch.xml.tpl" \
  "$ROOT_DIR/scripts/a02-ingress-probe.mjs" "$0" > "$RUN_DIR/source-sha256.txt"
"$NODE_BIN" "$ROOT_DIR/scripts/a02-ingress-probe.mjs" render "$RUN_DIR"

docker run -d --name "$CONTAINER" --network none --pids-limit 128 --memory 512m \
  --security-opt no-new-privileges --cap-drop ALL \
  --mount "type=bind,src=$RUN_DIR,dst=/a02" --entrypoint freeswitch "$IMAGE" \
  -nonat -nf -conf /a02 -log /a02 -db /a02 -run /a02 > "$RUN_DIR/container-id.txt"
docker inspect "$CONTAINER" --format '{{json .HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' > "$RUN_DIR/isolation.txt"
PID="$(docker inspect "$CONTAINER" --format '{{.State.Pid}}')"
# Enter only the NEW container's network namespace; keep host Node and files.
nsenter --net="/proc/$PID/ns/net" "$NODE_BIN" "$ROOT_DIR/scripts/a02-ingress-probe.mjs" probe "$RUN_DIR"
