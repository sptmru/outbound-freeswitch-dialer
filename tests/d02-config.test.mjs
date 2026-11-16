import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const root = fileURLToPath(new URL("..", import.meta.url));
async function fixture() {
  const directory = await mkdtemp("/tmp/d02-startup-");
  const config = join(directory, "conf"),
    generated = join(directory, "generated");
  await mkdir(join(config, "autoload_configs"), { recursive: true });
  await writeFile(
    join(config, "autoload_configs", "modules.conf.xml"),
    "<configuration><modules>\n</modules></configuration>"
  );
  await writeFile(
    join(config, "autoload_configs", "switch.conf.xml"),
    '<configuration><settings>\n<param name="rtp-start-port" value="1"/>\n<param name="rtp-end-port" value="2"/>\n<param name="max-sessions" value="1000"/>\n<param name="sessions-per-second" value="1000"/>\n</settings></configuration>'
  );
  const env = {
    PATH: process.env.PATH,
    TEMPLATE_DIR: join(root, "infra/freeswitch/templates"),
    FREESWITCH_CONFIG_DIR: config,
    FREESWITCH_GENERATED_CONFIG_DIR: generated,
    FREESWITCH_LOG_DIR: join(directory, "log"),
    FREESWITCH_DB_DIR: join(directory, "db"),
    FREESWITCH_RENDER_ONLY: "true",
    FREESWITCH_ESL_PASSWORD: "d02-test-only",
    FREESWITCH_ESL_ACL: "loopback.auto",
    FREESWITCH_DOMAIN: "d02.invalid",
    FREESWITCH_RTP_START_PORT: "20000",
    FREESWITCH_RTP_END_PORT: "20040",
    FREESWITCH_EXTERNAL_SIP_IP: "127.0.0.1",
    FREESWITCH_EXTERNAL_RTP_IP: "127.0.0.1",
    FREESWITCH_INTERNAL_SIP_PORT: "5080",
    FREESWITCH_EXTERNAL_PROFILE_SIP_PORT: "5090",
    FREESWITCH_EXTERNAL_PROFILE_TLS_PORT: "5091",
    FREESWITCH_WEBRTC_WSS_PORT: "7443",
    SIP_TRUNK_MODE: "ip_auth"
  };
  return {
    directory,
    config,
    generated,
    env,
    run: (extra) =>
      execFileSync("sh", [join(root, "infra/freeswitch/entrypoint.sh")], {
        env: { ...env, ...extra },
        stdio: "pipe"
      })
  };
}

test("D02.3 startup discards interrupted candidate, restores only last-good, and feature-off forces denial", async () => {
  const f = await fixture();
  try {
    f.run({ FREESWITCH_INBOUND_CONFIG_ENABLED: "true" });
    const active = join(f.generated, "dialplan/public/00-inbound.xml");
    assert.match(await readFile(active, "utf8"), /d02_disabled/);
    const good = '<include><extension name="last-good-fixture"/></include>\n';
    await writeFile(join(f.generated, "inbound/last-good.xml"), good);
    await writeFile(active, "<include><broken>");
    f.run({ FREESWITCH_INBOUND_CONFIG_ENABLED: "true" });
    assert.equal(await readFile(active, "utf8"), good);
    assert.equal(await readlink(join(f.config, "dialplan/public/00-inbound.xml")), active);
    f.run({ FREESWITCH_INBOUND_CONFIG_ENABLED: "false" });
    assert.match(await readFile(active, "utf8"), /d02_disabled/);
    assert.equal(await readFile(join(f.generated, "inbound/last-good.xml"), "utf8"), good);
    const publicContext = await readFile(join(f.config, "dialplan/public.xml"), "utf8");
    assert.doesNotMatch(publicContext, /public_extensions|transfer|deflect/);
    assert.match(publicContext, /data="public\/\*\.xml"/);
    assert.match(
      await readFile(join(f.config, "dialplan/agent-ingress.xml"), "utf8"),
      /context name="agent-ingress"/
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("D02.1 startup validates finite global session/rate guards and renders selected bounds", async () => {
  const f = await fixture();
  try {
    for (const extra of [
      { FREESWITCH_MAX_SESSIONS: "0" },
      { FREESWITCH_MAX_SESSIONS: "201" },
      { FREESWITCH_MAX_SESSIONS: "80;cmd" },
      { FREESWITCH_SESSIONS_PER_SECOND: "0" },
      { FREESWITCH_SESSIONS_PER_SECOND: "101" },
      { FREESWITCH_INBOUND_CONFIG_ENABLED: "yes" }
    ])
      assert.throws(() => f.run(extra));
    f.run({ FREESWITCH_MAX_SESSIONS: "80", FREESWITCH_SESSIONS_PER_SECOND: "20" });
    const xml = await readFile(join(f.config, "autoload_configs/switch.conf.xml"), "utf8");
    assert.match(xml, /max-sessions" value="80"/);
    assert.match(xml, /sessions-per-second" value="20"/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
