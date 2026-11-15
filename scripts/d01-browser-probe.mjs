// Real production softphone hook + HTTP lifecycle, Chromium WSS/DTLS-SRTP.
// Reservations and terminal reconciliation are fixtures, not E/G executors.
/* global window, AudioContext, MediaStream */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import net from "node:net";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { render } from "./a05-rebridge-probe.mjs";
import { openEsl } from "./a02-ingress-probe.mjs";
import { endpoint, until, assertTone } from "./a05-media.mjs";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import { DeskSessions } from "../apps/api/dist-test/desk-sessions.js";
import { registerDeskSessionRoutes } from "../apps/api/dist-test/dashboard/desk-sessions.js";
import { signAuthToken } from "../apps/api/dist-test/auth/tokens.js";
import { provisionAgentDirectory } from "../apps/api/dist-test/freeswitch/provisioning.js";
import { withCallAdmission } from "../apps/api/dist-test/call-admission.js";
import { reserveAgentCallSlot } from "../apps/api/dist-test/agent-call-slots.js";
import { enqueueCallCommand } from "../apps/api/dist-test/call-executor.js";

const [mode, directory] = process.argv.slice(2);
assert.match(directory ?? "", /^\/tmp\/outbound-d01\.[A-Za-z0-9]+$/);
if (mode === "render") {
  await render(directory);
  await mkdir(join(directory, "certs"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      join(directory, "certs/wss.key"),
      "-out",
      join(directory, "certs/wss.crt")
    ],
    { stdio: "ignore" }
  );
  const pem = Buffer.concat([
    await readFile(join(directory, "certs/wss.key")),
    await readFile(join(directory, "certs/wss.crt"))
  ]);
  for (const name of ["wss.pem", "dtls-srtp.pem", "agent.pem"])
    await writeFile(join(directory, "certs", name), pem, { mode: 0o600 });
  let xml = await readFile(join(directory, "freeswitch.xml"), "utf8");
  xml = xml
    .replace(
      '<section name="configuration">',
      '<X-PRE-PROCESS cmd="set" data="certs_dir=/a02/certs"/>\n<section name="configuration">'
    )
    .replaceAll("a04-loopback", "internal-webrtc")
    .replace("<users>", '<users>\n<X-PRE-PROCESS cmd="include" data="/a02/directory/default/*.xml"/>\n')
    .replace(
      '<param name="sip-port" value="5080"/>',
      '<param name="sip-port" value="5080"/><param name="wss-binding" value="127.0.0.1:7443"/><param name="tls-cert-dir" value="/a02/certs"/>'
    );
  await writeFile(join(directory, "freeswitch.xml"), xml, { mode: 0o600 });
  // Native Chromium fake capture uses a decoded file, not a mocked media API.
  const samples = 48000,
    wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(14000 * Math.sin((2 * Math.PI * 880 * i) / 48000)), 44 + i * 2);
  await writeFile(join(directory, "microphone.wav"), wav);
  await build({
    configFile: false,
    root: new URL("./fixtures/d01-browser", import.meta.url).pathname,
    plugins: [react()],
    build: { target: "esnext", outDir: join(directory, "web"), emptyOutDir: true }
  });
  process.exit(0);
}
assert.equal(mode, "probe");
const report = {
  date: new Date().toISOString(),
  scenarios: [],
  commands: [],
  browserErrors: [],
  signaling: [],
  limitations: [],
  boundary:
    "Real Chromium production useSoftphoneRegistration/DeskSessionController, native HTTP/PostgreSQL, real WSS and bidirectional decoded WebRTC DTLS-SRTP/UDP PCMU; synthetic audio, seeded reservation states, accelerated DB expiry, fixture terminal cleanup; no provider/production or future E/G executors"
};
const save = () => writeFile(join(directory, "browser-report.json"), JSON.stringify(report, null, 2));
let f, observer, app, browser, customer, transferSource;
let blocked = false;
const sockets = new Set();
const proxy = net.createServer((incoming) => {
  if (blocked) {
    incoming.destroy();
    return;
  }
  const outgoing = net.connect(7443, "127.0.0.1");
  sockets.add(incoming);
  sockets.add(outgoing);
  incoming.pipe(outgoing).pipe(incoming);
  for (const [a, b] of [
    [incoming, outgoing],
    [outgoing, incoming]
  ]) {
    a.on("error", () => a.destroy());
    a.on("close", () => {
      sockets.delete(a);
      b.destroy();
    });
  }
});
let chain = Promise.resolve();
async function command(text) {
  const next = chain.then(() => observer.command(`api ${text}`));
  chain = next.catch(() => {});
  const body = (await next).body.trim();
  report.commands.push({ text, body });
  return body;
}
async function pass(name, evidence = {}) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
async function browserTone(page) {
  return page.evaluate(async () => {
    const pc = window.d01Peers.at(-1);
    const receiver = pc.getReceivers().find((r) => r.track?.kind === "audio");
    const ctx = new AudioContext();
    await ctx.resume();
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([receiver.track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      source.connect(analyser);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      const power = (hz) => {
        let re = 0,
          im = 0;
        for (let i = 0; i < data.length; i++) {
          re += data[i] * Math.cos((2 * Math.PI * hz * i) / ctx.sampleRate);
          im += data[i] * Math.sin((2 * Math.PI * hz * i) / ctx.sampleRate);
        }
        return Math.hypot(re, im) / data.length;
      };
      const stats = Array.from((await pc.getStats()).values());
      const transport = stats.find((s) => s.type === "transport");
      return {
        tone: power(440),
        noise: power(1337),
        samples: data.length,
        rate: ctx.sampleRate,
        connectionState: pc.connectionState,
        dtlsState: transport?.dtlsState,
        received: stats
          .filter((s) => s.type === "inbound-rtp")
          .map((s) => ({ packetsReceived: s.packetsReceived, bytesReceived: s.bytesReceived })),
        peers: window.d01Peers.length
      };
    } finally {
      await ctx.close();
    }
  });
}
async function media(page) {
  let audio;
  await until(
    async () => {
      audio = await browserTone(page);
      return audio.tone > 0.005 && audio.tone > audio.noise * 5;
    },
    "browser decoded 440 Hz",
    10000
  );
  assert.equal(audio.dtlsState, "connected");
  assert.equal(audio.connectionState, "connected");
  const offset = customer.received.length;
  await until(() => customer.received.length > offset + 4000, "far end RTP", 5000);
  return { browser: audio, customer: assertTone(customer.received.slice(offset + 1600, offset + 4000), 880) };
}
async function seedTransferReservation(config) {
  // Actual source/recipient identities, slots, transfer row and overlap permits;
  // orchestration remains fixture-controlled rather than the future G executor.
  const user = (
    await f.pool.query(
      "insert into users(email,name,role,password_hash) values($1,'Fixture source','agent','fixture') returning id",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0];
  const identity = {
    username: `desk_${randomUUID().replaceAll("-", "")}`,
    password: randomBytes(24).toString("hex")
  };
  const agent = (
    await f.pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,status) values($1,$2,'fixture','fixture','Fixture source','in_call') returning id",
      [user.id, identity.username]
    )
  ).rows[0];
  await f.pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [agent.id]
  );
  await provisionAgentDirectory(config, {
    sipUsername: identity.username,
    sipPassword: identity.password,
    displayName: "Fixture source"
  });
  await command("reloadxml");
  transferSource = await endpoint({ ...identity, source: "127.0.0.6", frequency: 660 });
  await transferSource.register();
  const sourceTarget = await command(`sofia_contact internal-webrtc/${identity.username}@a04.invalid`);
  const callId = randomUUID(),
    participantId = randomUUID(),
    sourceParticipantId = randomUUID(),
    customerId = randomUUID();
  const agentUuid = randomUUID(),
    sourceUuid = randomUUID(),
    customerUuid = randomUUID(),
    transferId = randomUUID();
  const client = await f.pool.connect();
  try {
    await withCallAdmission(client, { callIds: [callId], agentIds: [f.agentId, agent.id] }, async (a) => {
      await a.client.query(
        "insert into calls(id,campaign_id,agent_id,destination_number,normalized_destination_number,state,direction,answered_at,pstn_answered_at) values($1,$2,$3,'+14155550100','+14155550100','bridged','outbound',clock_timestamp(),clock_timestamp())",
        [callId, f.campaignId, agent.id]
      );
      await a.client.query(
        "insert into call_participants(id,call_id,role,agent_id) values($1,$2,'agent',$3),($4,$2,'agent',$5),($6,$2,'customer',null)",
        [participantId, callId, f.agentId, sourceParticipantId, agent.id, customerId]
      );
      await a.client.query(
        "insert into call_legs(call_id,participant_id,type,freeswitch_uuid,state) values($1,$2,'agent',$3,'answered'),($1,$4,'agent',$5,'answered'),($1,$6,'customer',$7,'answered')",
        [callId, participantId, agentUuid, sourceParticipantId, sourceUuid, customerId, customerUuid]
      );
      let transferOperation;
      for (const [agentId, participant, kind] of [
        [f.agentId, participantId, "transfer"],
        [agent.id, sourceParticipantId, "outbound"]
      ]) {
        const slot = await reserveAgentCallSlot(a.client, agentId, callId, participant);
        assert.ok(slot);
        const operationId = randomUUID();
        await enqueueCallCommand(a, {
          id: operationId,
          callId,
          scope: "d01-browser-fixture",
          key: randomUUID(),
          fingerprint: "a".repeat(64),
          kind: kind === "transfer" ? "rebridge" : "originate",
          generation: slot.generation,
          commandUuid: randomUUID(),
          targetUuid: kind === "transfer" ? agentUuid : sourceUuid,
          request: { slot, customerUuid },
          deadline: new Date(Date.now() + 60000)
        });
        await a.capacity.claim({ kind, callId, operationId, generation: slot.generation, agentId });
        await a.client.query(
          "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='fixture established legs; no G executor' where id=$1",
          [operationId]
        );
        if (kind === "transfer") transferOperation = operationId;
      }
      await a.client.query(
        "insert into call_transfers(id,call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,operation_id,state,deadline_at) values($1,$2,1,$3,$4,$5,$6,'connecting',clock_timestamp()+interval '10 minutes')",
        [transferId, callId, agent.id, sourceParticipantId, f.agentId, transferOperation]
      );
    });
  } finally {
    client.release();
  }
  return { callId, participantId, customerId, agentUuid, customerUuid, sourceUuid, sourceTarget, transferId };
}
try {
  await until(
    async () => {
      try {
        observer = await openEsl();
        return /RUNNING/.test((await observer.command("api sofia status")).body);
      } catch {
        observer?.close();
        return false;
      }
    },
    "FS startup",
    15000
  );
  report.fs = await command("version");
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const config = {
    JWT_SECRET: "d01-browser-isolated-only",
    JWT_EXPIRES_SECONDS: 3600,
    FREESWITCH_ESL_ENABLED: true,
    FREESWITCH_ESL_HOST: "127.0.0.1",
    FREESWITCH_ESL_PORT: 8021,
    FREESWITCH_ESL_PASSWORD: "a02-disposable-only",
    FREESWITCH_DOMAIN: "a04.invalid",
    FREESWITCH_GENERATED_CONFIG_DIR: directory,
    FREESWITCH_WEBRTC_PUBLIC_WS_URL: `wss://127.0.0.1:${proxy.address().port}`
  };
  f = await cleanupFixture({
    host: join(directory, "socket"),
    database: "d01",
    user: "postgres",
    connectionTimeoutMillis: 1000
  });
  const user = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];
  const service = new DeskSessions(f.pool, config);
  app = Fastify();
  await app.register(cookie);
  await app.register(async (scoped) => registerDeskSessionRoutes(scoped, config, f.pool, service), {
    prefix: "/api"
  });
  app.get("/fixture/bootstrap", async () => ({
    user: { id: user.id, email: user.email, name: user.name, role: "agent", isActive: true },
    campaignId: f.campaignId,
    revision:
      (
        await f.pool.query(
          "select revision from agent_desk_sessions where agent_id=$1 and revoked_at is null order by binding_generation desc limit 1",
          [f.agentId]
        )
      ).rows[0]?.revision ?? null
  }));
  await app.register(staticFiles, { root: join(directory, "web") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const token = signAuthToken(config, {
    sub: user.id,
    email: user.email,
    role: "agent",
    ver: user.auth_version
  });
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--allow-loopback-in-peer-connection",
      "--ignore-certificate-errors",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-audio-capture=${join(directory, "microphone.wav")}`
    ]
  });
  report.chromium = browser.version();
  const identity = {
    username: `desk_${randomUUID().replaceAll("-", "")}`,
    password: randomBytes(24).toString("hex")
  };
  await provisionAgentDirectory(config, {
    sipUsername: identity.username,
    sipPassword: identity.password,
    displayName: "Fixture customer"
  });
  await command("reloadxml");
  customer = await endpoint({ ...identity, source: "127.0.0.5", frequency: 440 });
  await customer.register();
  const target = await command(`sofia_contact internal-webrtc/${identity.username}@a04.invalid`);
  for (const direction of process.env.D01_BROWSER_SMOKE === "1"
    ? ["inbound"]
    : ["inbound", "outbound", "transfer"]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone"] });
    await context.addCookies([{ name: "outbound_dialer_session", value: token, url: address }]);
    await context.addInitScript(() => {
      window.localStorage.setItem("outbound_dialer_audio_processing_profile", "headset");
      window.d01Peers = [];
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(...args) {
          super(...args);
          window.d01Peers.push(this);
        }
      };
    });
    const page = await context.newPage();
    page.on("websocket", (ws) => {
      for (const [event, direction] of [
        ["framesent", "sent"],
        ["framereceived", "received"]
      ])
        ws.on(event, (frame) => {
          const text = frame.payload.toString();
          report.signaling.push({
            direction,
            line: text.split("\r\n")[0],
            cseq: text.match(/\r\nCSeq: ([^\r]+)/i)?.[1]
          });
        });
    });
    page.on("pageerror", (error) => report.browserErrors.push(error.message));
    await page.goto(address);
    try {
      await page.waitForFunction(() => window.d01?.deskSession?.ready && window.d01.registered, null, {
        timeout: 20000
      });
    } catch (error) {
      console.log(await page.locator("body").innerText());
      throw error;
    }
    const initial = await page.evaluate(() => window.d01.deskSession);
    const seeded =
      direction === "transfer"
        ? await seedTransferReservation(config)
        : await f.seed({ inbound: direction === "inbound" });
    const contact = (
      await f.pool.query("select verified_endpoint from agent_desk_sessions where id=$1", [initial.id])
    ).rows[0].verified_endpoint;
    for (const [uuid, destination] of [
      [seeded.agentUuid, contact],
      [seeded.customerUuid, target],
      ...(seeded.sourceUuid ? [[seeded.sourceUuid, seeded.sourceTarget]] : [])
    ]) {
      assert.match(
        (
          await observer.command(
            `bgapi originate {origination_uuid=${uuid},originate_timeout=15,media_webrtc=${uuid === seeded.agentUuid},absolute_codec_string=PCMU,hangup_after_bridge=false,park_after_bridge=true}${destination} &park()`
          )
        ).headers["reply-text"],
        /^\+OK/
      );
      await until(
        () => observer.events.some((e) => e["event-name"] === "CHANNEL_ANSWER" && e["unique-id"] === uuid),
        `answered ${uuid}`,
        18000
      );
    }
    await command(`uuid_bridge ${seeded.agentUuid} ${seeded.customerUuid}`);
    await page.waitForFunction(() => window.d01?.callState === "active");
    const baseline = await media(page);
    const cases = [];
    for (const state of process.env.D01_BROWSER_SMOKE === "1"
      ? ["active"]
      : ["reserved", "connecting", "active", "releasing", "uncertain"]) {
      await f.pool.query("update agent_call_slots set state=$2 where agent_id=$1", [f.agentId, state]);
      const slot = (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.agentId]))
        .rows[0];
      const authority = async () => ({
        slots: (
          await f.pool.query("select * from agent_call_slots where call_id=$1 order by agent_id", [
            seeded.callId
          ])
        ).rows,
        capacity: (
          await f.pool.query("select * from call_capacity_reservations where call_id=$1 order by id", [
            seeded.callId
          ])
        ).rows,
        transfers: (
          await f.pool.query("select * from call_transfers where call_id=$1 order by id", [seeded.callId])
        ).rows
      });
      const held = await authority();
      const current = (await f.pool.query("select * from agent_desk_sessions where id=$1", [initial.id]))
        .rows[0];
      const takeover = await app.inject({
        method: "POST",
        url: "/api/agent/desk-sessions",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId: f.campaignId,
          expectedRevision: current.revision,
          idempotencyKey: randomUUID()
        }
      });
      assert.equal(takeover.statusCode, 409);
      assert.equal(takeover.json().code, "slot_occupied");
      // Stop heartbeat delivery as well as WSS; accelerate the database lease clock.
      await page.route("**/api/agent/desk-sessions/*", (route) => route.abort());
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await page.waitForFunction(() => window.d01?.registered === false, { timeout: 5000 });
      await f.pool.query(
        "update agent_desk_sessions set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=$1",
        [initial.id]
      );
      await service.reconcile();
      const lost = (await f.pool.query("select * from agent_desk_sessions where id=$1", [initial.id]))
        .rows[0];
      assert.equal(lost.ready, false);
      assert.equal(lost.revoked_at, null);
      assert.deepEqual(
        (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.agentId])).rows[0],
        slot
      );
      assert.equal(await page.evaluate(() => window.d01.callState), "active");
      const disconnected = await media(page);
      assert.deepEqual(
        await authority(),
        held,
        "registration/lease loss preserves all slots, capacity and accepted transfer work"
      );
      assert.equal(disconnected.browser.peers, baseline.browser.peers, "no replacement media connection");
      assert.equal(await command(`uuid_exists ${seeded.agentUuid}`), "true");
      blocked = false;
      await page.unroute("**/api/agent/desk-sessions/*");
      await page.waitForFunction(() => window.d01?.registered === true, { timeout: 20000 });
      await until(
        async () =>
          (
            await f.pool.query(
              "select expires_at>clock_timestamp() as live from agent_desk_sessions where id=$1",
              [initial.id]
            )
          ).rows[0].live,
        "same generation heartbeat renewal",
        18000
      );
      const recovered = await media(page);
      assert.deepEqual(
        await authority(),
        held,
        "reconnect preserves source/recipient capacity and transfer identity"
      );
      assert.deepEqual(
        (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.agentId])).rows[0],
        slot
      );
      const renewed = (await f.pool.query("select * from agent_desk_sessions where id=$1", [initial.id]))
        .rows[0];
      assert.equal(renewed.binding_generation, current.binding_generation);
      assert.equal(renewed.endpoint_pin, current.endpoint_pin);
      const refreshedContact = await command(
        `sofia_contact internal-webrtc/${current.sip_username}@a04.invalid`
      );
      if (refreshedContact !== current.endpoint_pin)
        assert.equal(renewed.ready, false, "moved/ambiguous contact remains unavailable");
      cases.push({
        state,
        disconnected,
        recovered,
        ready: renewed.ready,
        generation: renewed.binding_generation,
        transferId: seeded.transferId,
        resources: held.capacity.map((row) => ({
          id: row.id,
          resource: row.resource_type,
          agentId: row.agent_id,
          generation: row.generation,
          state: row.state
        })),
        slot
      });
      await pass(
        `${direction}/${state}: WSS loss, lease expiry, media survival and same-controller reconnect`,
        cases.at(-1)
      );
    }
    await command(`uuid_kill ${seeded.agentUuid} NORMAL_CLEARING`);
    await command(`uuid_kill ${seeded.customerUuid} NORMAL_CLEARING`);
    if (seeded.sourceUuid) await command(`uuid_kill ${seeded.sourceUuid} NORMAL_CLEARING`);
    try {
      await page.waitForFunction(() => window.d01?.callState === "none", null, { timeout: 3000 });
    } catch {
      report.limitations.push({
        direction,
        check: "remote BYE after WSS reconnect",
        status: "failed",
        observed:
          "FreeSWITCH channels terminated, but browser did not receive BYE and retained its session; explicit browser hangup used for fixture teardown"
      });
      await page.evaluate(() => window.d01.hangUpSoftphoneCall());
      await page.waitForFunction(() => window.d01?.callState === "none");
    }
    await f.pool.query("update call_legs set ended_at=clock_timestamp(),state='ended' where call_id=$1", [
      seeded.callId
    ]);
    await f.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
      seeded.callId
    ]);
    await f.pool.query(
      "update agent_call_slots set state='free',call_id=null,participant_id=null,reservation_id=null,reconciliation_required=false where call_id=$1",
      [seeded.callId]
    );
    if (seeded.transferId)
      await f.pool.query(
        "update call_transfers set state='completed',closed_at=clock_timestamp(),reason='fixture_terminal_cleanup' where id=$1",
        [seeded.transferId]
      );
    await page.getByRole("button", { name: "Leave Desk" }).click();
    await until(
      async () =>
        (
          await f.pool.query(
            "select revoked_at is not null as revoked from agent_desk_sessions where id=$1",
            [initial.id]
          )
        ).rows[0].revoked,
      "browser leave commits its revocation"
    );
    await context.close();
    await pass(`${direction}: explicit terminal fixture cleanup and browser leave`, { cases: cases.length });
  }
  await until(async () => (await command("show channels count")).startsWith("0 total"), "no live channels");
  assert.deepEqual(report.browserErrors, []);
  assert.equal(
    (await f.pool.query("select count(*)::int n from agent_desk_sessions where revoked_at is null")).rows[0]
      .n,
    0
  );
  report.status = report.limitations.length ? "matrix_passed_with_failed_terminal_check" : "passed";
  if (report.limitations.length) process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  if (observer)
    report.events = observer.events.map((e) => ({
      name: e["event-name"],
      uuid: e["unique-id"],
      cause: e["hangup-cause"]
    }));
  blocked = true;
  for (const socket of sockets) socket.destroy();
  await browser?.close();
  customer?.close();
  transferSource?.close();
  await app?.close();
  proxy.close();
  observer?.close();
  if (f) await f.cleanup();
  await save();
}
