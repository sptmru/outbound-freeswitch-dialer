import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));

test("agent SIP ingress cannot route PSTN calls outside backend-owned ESL control", async () => {
  const [profile, provisioning, entrypoint, agentPolicy, publicPolicy] = await Promise.all([
    read("infra/freeswitch/templates/sip_profiles/internal-webrtc.xml.tpl"),
    read("apps/api/src/freeswitch/provisioning.ts"),
    read("infra/freeswitch/entrypoint.sh"),
    read("infra/freeswitch/templates/dialplan/agent-ingress/reject.xml.tpl"),
    read("infra/freeswitch/templates/dialplan/public/reject.xml.tpl")
  ]);

  assert.match(profile, /<param name="context" value="agent-ingress"\/>/);
  assert.doesNotMatch(profile, /<param name="context" value="default"\/>/);
  assert.match(provisioning, /<variable name="user_context" value="agent-ingress"\/>/);
  assert.match(
    entrypoint,
    /rm -rf "\$CONFIG_DIR\/dialplan\/default".*dialplan\/agent-ingress.*dialplan\/public/
  );
  assert.match(entrypoint, /escape_xml_for_sed/);
  assert.match(entrypoint, /s\/&\/\\&amp;\/g/);
  assert.doesNotMatch(entrypoint, /outbound-sip-trunk\.xml/);
  assert.match(agentPolicy, /403 Backend call control required/);
  assert.match(agentPolicy, /hangup" data="CALL_REJECTED"/);
  assert.match(publicPolicy, /403 Inbound calling is not enabled/);
  assert.doesNotMatch(`${agentPolicy}\n${publicPolicy}`, /sofia\/(?:gateway|external)/);
});

test("Docker build context excludes runtime media and generated secrets", async () => {
  const dockerignore = await read(".dockerignore");
  for (const pattern of [".env*", "backups", "infra/freeswitch/recordings", "logs", "monitoring/generated"]) {
    assert.match(dockerignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});

test("production proxy accepts the configured voicemail upload envelope", async () => {
  const [proxyTemplate, proxyEntrypoint] = await Promise.all([
    read("infra/proxy/nginx.conf.tpl"),
    read("infra/proxy/entrypoint.sh")
  ]);
  assert.match(
    proxyTemplate,
    /location \/api\/ \{\s+client_max_body_size \$\{PROXY_MAX_REQUEST_BODY_SIZE\};/
  );
  assert.match(proxyEntrypoint, /proxy_max_request_body_size="\$\{PROXY_MAX_REQUEST_BODY_SIZE:-70m\}"/);
  assert.match(proxyEntrypoint, /export PROXY_MAX_REQUEST_BODY_SIZE="\$\{proxy_max_request_body_size\}"/);
  assert.match(proxyEntrypoint, /grep -Eq '\^\[1-9\]\[0-9\]\*\[kKmMgG\]\?\$'/);
});

test("voicemail playback events use FreeSWITCH comma-separated event headers", async () => {
  const dialplan = await read("infra/freeswitch/templates/dialplan/default/voicemail-drop.xml.tpl");

  for (const kind of ["started", "completed", "failed"]) {
    assert.ok(
      dialplan.includes(
        `Event-Subclass=outbound_dialer::voicemail_playback_${kind},Outbound-Dialer-Call-ID=\${voicemail_drop_call_id},Outbound-Dialer-Customer-Leg-UUID=\${uuid}`
      ),
      kind
    );
  }
});

test("monitoring cannot mutate the Docker daemon through a raw socket", async () => {
  const [compose, alloy] = await Promise.all([
    read("infra/docker/docker-compose.yml"),
    read("monitoring/alloy/config.alloy")
  ]);
  assert.match(compose, /docker-socket-proxy:/);
  assert.match(compose, /POST: "0"/);
  assert.match(compose, /NETWORKS: "1"/);
  assert.doesNotMatch(compose.match(/ {2}alloy:[\s\S]*?(?=\nvolumes:)/)?.[0] ?? "", /docker\.sock/);
  assert.match(alloy, /tcp:\/\/docker-socket-proxy:2375/);
});

test("deployment secures the environment and always installs locked dependencies", async () => {
  const deploy = await read("scripts/deploy.sh");
  const chmodIndex = deploy.indexOf('chmod 600 "${ENV_FILE}"');
  const preflightIndex = deploy.indexOf('ENV_FILE="${ENV_FILE}" "${ROOT_DIR}/scripts/preflight.sh"');
  const installIndex = deploy.indexOf('npm --prefix "${ROOT_DIR}" ci');
  const skipChecksIndex = deploy.indexOf('if [[ "${SKIP_DEPLOY_CHECKS:-false}" != "true" ]]');

  assert.ok(chmodIndex >= 0 && chmodIndex < preflightIndex);
  assert.ok(installIndex > preflightIndex && installIndex < skipChecksIndex);
});

function read(relativePath) {
  return readFile(join(rootDirectory, relativePath), "utf8");
}
