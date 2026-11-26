import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openEsl, invite } from "./a02-ingress-probe.mjs";
import { endpoint, until, assertTone } from "./a05-media.mjs";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import {
  InboundConfigurationPublisher,
  atomicConfigurationWrite
} from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { provisionAgentDirectory } from "../apps/api/dist-test/freeswitch/provisioning.js";
import { sendFreeSwitchApiCommand } from "../apps/api/dist-test/esl.js";
const directory = process.argv[2];
assert.match(directory ?? "", /^\/tmp\/outbound-d02\.[A-Za-z0-9]+$/);
const config = {
  FREESWITCH_ESL_ENABLED: true,
  FREESWITCH_INBOUND_CONFIG_ENABLED: true,
  FREESWITCH_ESL_HOST: "127.0.0.1",
  FREESWITCH_ESL_PORT: 8021,
  FREESWITCH_ESL_PASSWORD: "a02-disposable-only",
  FREESWITCH_DOMAIN: "a04.invalid",
  FREESWITCH_GENERATED_CONFIG_DIR: join(directory, "generated"),
  FREESWITCH_INBOUND_TRUSTED_CIDRS: "127.0.0.2/32",
  FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT: 1,
  FREESWITCH_TRUNK_CHANNEL_LIMIT: 2,
  FREESWITCH_INBOUND_WAIT_SECONDS: 3
};
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  boundary:
    "Real product entrypoint/templates, native DB schema/publisher, isolated UDP SIP/PCMU RTP; D03 admission unavailable, no browser/provider/production"
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
async function command(text) {
  const body = (await sendFreeSwitchApiCommand(config, text)).body.trim();
  report.commands.push({ text, body });
  return body;
}
async function pass(name, evidence = {}) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
let observer, f;
const clients = [];
async function ready() {
  await until(
    async () => {
      try {
        observer?.close();
        observer = await openEsl();
        return /internal-webrtc.*RUNNING/.test(await command("sofia status"));
      } catch {
        return false;
      }
    },
    "FS product startup",
    30000
  );
}
const active = join(config.FREESWITCH_GENERATED_CONFIG_DIR, "dialplan/public/00-inbound.xml");
try {
  await ready();
  report.fs = await command("version");
  f = await cleanupFixture({
    host: join(directory, "socket"),
    database: "d02",
    user: "postgres",
    connectionTimeoutMillis: 2000
  });
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const queue = (await f.pool.query("select id from inbound_queues limit 1")).rows[0].id;
  const enabled = (
    await f.pool.query(
      "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values('+12025550100','enabled',$1,true) returning id",
      [queue]
    )
  ).rows[0].id;
  await f.pool.query(
    "insert into inbound_numbers(normalized_did,label,queue_id) values('+12025550101','disabled',$1)",
    [queue]
  );
  const publisher = () => new InboundConfigurationPublisher(f.pool, config);
  assert.equal(await publisher().reconcile(), "applied");
  await pass("D02.2 real reload and loaded revision verified");
  for (const spec of [
    { name: "untrusted", source: "127.0.0.3", status: 403 },
    { name: "unknown", did: "+12025550109", status: 404 },
    { name: "vanilla extension cannot bypass trust", source: "127.0.0.3", did: "1000", status: 403 },
    { name: "disabled", did: "+12025550101", status: 403 },
    { name: "admission-unavailable", status: 503 },
    { name: "gateway DID without plus", gateway: "sip-trunk", did: "12025550100", status: 503 },
    { name: "gateway DID with plus", gateway: "sip-trunk", status: 503 },
    { name: "gateway disabled DID without plus", gateway: "sip-trunk", did: "12025550101", status: 403 },
    {
      name: "gateway unknown Request-URI DID with known To DID",
      gateway: "sip-trunk",
      did: "12025550109",
      toDid: "12025550100",
      status: 404
    },
    { name: "untrusted gateway DID", gateway: "sip-trunk", source: "127.0.0.3", status: 403 },
    { name: "forged headers", forged: true, status: 503 }
  ]) {
    const result = await invite({ ...spec, port: 5090 });
    assert.equal(result.final, spec.status, JSON.stringify(result.messages));
    assert.equal(result.rtp.length, 0);
    assert.ok(result.messages.find((m) => m.first.startsWith(`SIP/2.0 ${spec.status}`)).ms < 3000);
    if (spec.gateway) {
      await until(
        () =>
          observer.events.some(
            (e) =>
              e["event-name"] === "CHANNEL_HANGUP_COMPLETE" &&
              e["variable_sip_call_id"] === result.callId &&
              e["variable_sip_gateway"] === spec.gateway
          ),
        "gateway INVITE observed"
      );
    }
    await pass(`D02.1 ${spec.name}`, {
      sipStatus: result.final,
      messages: result.messages.map((m) => ({ first: m.first, ms: m.ms }))
    });
  }
  const trustedCidrs = config.FREESWITCH_INBOUND_TRUSTED_CIDRS;
  config.FREESWITCH_INBOUND_TRUSTED_CIDRS = "*";
  assert.equal(await publisher().reconcile(), "applied");
  for (const spec of [
    { did: "+12025550100", status: 503 },
    { did: "+12025550101", status: 403 },
    { did: "+12025550109", status: 404 }
  ]) {
    const result = await invite({ did: spec.did, source: "127.0.0.3", port: 5090 });
    assert.equal(result.final, spec.status, JSON.stringify(result.messages));
    assert.equal(result.rtp.length, 0);
    await pass(`D02.1 wildcard routes ${spec.did} from a previously untrusted SIP source`, {
      sipStatus: result.final,
      messages: result.messages.map((m) => ({ first: m.first, ms: m.ms }))
    });
  }
  // Authenticated UDP media endpoints use the product generated directory and
  // deny-all agent-ingress context. No browser or mock media is involved.
  for (let i = 0; i < 2; i++) {
    const identity = { username: `desk_d02_${i}`, password: randomBytes(24).toString("hex") };
    await provisionAgentDirectory(config, {
      sipUsername: identity.username,
      sipPassword: identity.password,
      displayName: "D02 lab"
    });
    assert.match(await command("reloadxml"), /\+OK/);
    const c = await endpoint({ ...identity, source: `127.0.0.${i + 4}`, frequency: 440 + 220 * i });
    clients.push(c);
    await c.register();
  }
  const callId = await clients[0].dial({
    expectedStatus: 403,
    authenticate: true,
    destination: "+12025550199"
  });
  await until(
    () =>
      observer.events.some(
        (e) => e["event-name"] === "CHANNEL_HANGUP_COMPLETE" && e["variable_sip_call_id"] === callId
      ),
    "browser-originated PSTN request rejected"
  );
  assert.ok(
    !observer.events.some((e) => e["event-name"] === "CHANNEL_BRIDGE" && e["variable_sip_call_id"] === callId)
  );
  await pass("D02.1 authenticated agent-originated INVITE rejected");
  config.FREESWITCH_INBOUND_TRUSTED_CIDRS = trustedCidrs;
  assert.equal(await publisher().reconcile(), "applied");
  assert.equal((await invite({ source: "127.0.0.3", port: 5090 })).final, 403);
  const legs = [];
  for (const c of clients) {
    const target = await command(`sofia_contact internal-webrtc/${c.username}@a04.invalid`);
    assert.match(target, /^sofia\//);
    const id = randomUUID();
    assert.match(await command(`originate {origination_uuid=${id}}${target} &park()`), /\+OK/);
    legs.push(id);
  }
  assert.match(await command(`uuid_bridge ${legs[0]} ${legs[1]}`), /\+OK/);
  await until(
    () => observer.events.some((e) => e["event-name"] === "CHANNEL_BRIDGE" && e["unique-id"] === legs[0]),
    "real bridge"
  );
  const media = async () => {
    const n = clients[0].received.length;
    await until(() => clients[0].received.length > n + 4800, "ongoing decoded RTP");
    return assertTone(clients[0].received.slice(n + 1600, n + 4800), 660);
  };
  await media();
  // Pin actual native counters to live channels to control limit/limit+1 without
  // arbitrary timing. These fixture claims stand in for in-flight pre-admission.
  for (const [resource, limit] of [
    ["pre_admission", 1],
    ["trunk", 2]
  ]) {
    for (const id of legs.slice(0, limit))
      assert.match(await command(`uuid_limit ${id} hash outbound_dialer ${resource} ${limit}`), /\+OK/);
    assert.equal(Number(await command(`limit_usage hash outbound_dialer ${resource}`)), limit);
    const result = await invite({ port: 5090 });
    assert.equal(result.final, 503);
    assert.equal(result.rtp.length, 0);
    await media();
    for (const id of legs.slice(0, limit))
      await command(`uuid_limit_release ${id} hash outbound_dialer ${resource}`);
    await pass(`D02.1 native ${resource} capacity refuses excess and preserves bridged decoded audio`);
  }
  assert.match(await command("fsctl max_sessions 2"), /\+OK|2/);
  const saturated = await invite({ port: 5090 });
  assert.equal(saturated.final, 503);
  await media();
  // Lowering a core limit must preserve existing admitted channels/control.
  await command("fsctl max_sessions 1");
  for (const id of legs) assert.equal(await command(`uuid_exists ${id}`), "true");
  await command("fsctl max_sessions 80");
  await pass("D02.1 core pre-script channel guard and lowered limit preserve existing media");
  for (const id of legs) await command(`uuid_kill ${id} NORMAL_CLEARING`);
  await until(
    async () => Number((await command("show channels count")).match(/^\d+/)?.[0]) === 0,
    "channel cleanup"
  );
  const before = (await f.pool.query("select * from inbound_freeswitch_configuration")).rows[0];
  await f.pool.query("update inbound_numbers set enabled=false where id=$1", [enabled]);
  let failed = false;
  const bad = new InboundConfigurationPublisher(f.pool, config, {
    command: async (cmd) => {
      if (cmd === "reloadxml" && !failed) {
        failed = true;
        return "-ERR injected reload failure";
      }
      return command(cmd);
    }
  });
  assert.equal(await bad.reconcile(), "error");
  assert.equal(await readFile(active, "utf8"), before.applied_xml);
  const unchanged = await invite({ port: 5090 });
  assert.equal(unchanged.final, 503);
  await pass("D02.2 reload failure restores and verifies effective last-good routing");
  failed = false;
  const malformed = new InboundConfigurationPublisher(f.pool, config, {
    write: async (path, xml) => {
      if (!failed) {
        failed = true;
        await atomicConfigurationWrite(path, "<include><broken>");
      } else await atomicConfigurationWrite(path, xml);
    }
  });
  assert.equal(await malformed.reconcile(), "error");
  assert.equal(await readFile(active, "utf8"), before.applied_xml);
  assert.equal((await invite({ port: 5090 })).final, 503);
  await pass("D02.2 malformed-on-disk candidate cannot become applied and last-good routing is restored");
  assert.equal(await publisher().reconcile(), "applied");
  assert.equal((await invite({ port: 5090 })).final, 403);
  // Kill/restart only the runner-created FS container. Startup must discard the
  // interrupted candidate and restore last-good before accepting any SIP.
  await atomicConfigurationWrite(active, "<include><broken>");
  observer.close();
  const name = process.env.D02_FS_CONTAINER;
  assert.match(name, /^outbound-d02-fs-outbound-d02\.[A-Za-z0-9]+$/);
  execFileSync("docker", ["restart", name], { stdio: "pipe" });
  await ready();
  assert.equal((await invite({ port: 5090 })).final, 403);
  assert.equal(await publisher().reconcile(), "applied");
  await pass(
    "D02.3 FS restart restores last-good before traffic; fresh publisher reconciles actual loaded revision"
  );
  await atomicConfigurationWrite(active, "<include/>");
  const child = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import pg from "pg";
    import {InboundConfigurationPublisher} from "./apps/api/dist-test/freeswitch/inbound-config.js";
    const pool = new pg.Pool(JSON.parse(process.env.D02_DB));
    try { console.log(JSON.stringify({pid:process.pid,result:await new InboundConfigurationPublisher(pool,JSON.parse(process.env.D02_POLICY)).reconcile()})); }
    finally { await pool.end(); }
  `
      ],
      {
        env: {
          ...process.env,
          D02_POLICY: JSON.stringify(config),
          D02_DB: JSON.stringify({
            host: join(directory, "socket"),
            database: "d02",
            user: "postgres",
            max: 1,
            options: `-c search_path=${f.schema}`
          })
        },
        encoding: "utf8"
      }
    )
  );
  assert.notEqual(child.pid, process.pid);
  assert.equal(child.result, "applied");
  assert.equal((await invite({ port: 5090 })).final, 403);
  await pass("D02.3 independent API publisher process repairs disk drift and verifies actual routing", {
    pid: child.pid
  });
  assert.equal(Number((await command("show channels count")).match(/^\d+/)?.[0]), 0);
  assert.equal((await f.pool.query("select count(*)::int as n from calls")).rows[0].n, 0);
  assert.equal((await f.pool.query("select count(*)::int as n from call_operations")).rows[0].n, 0);
  await pass("D02 final zero channels/product calls/operations; unavailable admission never answers");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const c of clients) await c.close();
  observer?.close();
  if (f) await f.cleanup();
  await save();
}
