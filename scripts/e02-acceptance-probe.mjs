import { runSipRtpMixed } from "./i03-sip-mixed.mjs";
import { prefillSoakHistory, runSipRtpSoak } from "./i03-sip-soak.mjs";
import { runSipRtpLoad } from "./i03-sip-rtp.mjs";
import { proveTransferExecution, proveOutboundTransferExecution } from "./g02-transfer-execution.mjs";
import { proveQuiescentRecovery } from "./h01-quiescent-recovery.mjs";
import { proveLifecycleRecovery } from "./h01-recovery-matrix.mjs";
import assert from "node:assert/strict";
import { proveTransferSourceContinuity } from "./g01-transfer-continuity.mjs";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { open, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openEsl, invite } from "./a02-ingress-probe.mjs";
import { until, endpoint, decodeUlaw, assertTone } from "./a05-media.mjs";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import { limitedExecutor } from "../tests/fixtures/inbound/supervisor.mjs";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import {
  provisionAgentDirectory,
  reloadAgentDirectories
} from "../apps/api/dist-test/freeswitch/provisioning.js";
import { sendFreeSwitchApiCommand } from "../apps/api/dist-test/esl.js";
import { createInboundQueueCoordinator } from "../apps/api/dist-test/inbound-queue.js";
import { ingressRequest, readIngressRecords } from "../apps/api/dist-test/ingress-agent.js";
import { __testing as adapter } from "../apps/api/dist-test/esl-events.js";
import Fastify from "fastify";
import { registerCallOfferRoutes } from "../apps/api/dist-test/dashboard/call-offers.js";
import { signAuthToken } from "../apps/api/dist-test/auth/tokens.js";
import { dispatchInboundOffers } from "../apps/api/dist-test/inbound-dispatcher.js";
import { acceptInboundOffer } from "../apps/api/dist-test/inbound-acceptance.js";
import { relay } from "./a05-executor.mjs";
import { createCommandDriver } from "../apps/api/dist-test/call-command-transport.js";
import {
  settleInboundConnection,
  inboundConnectionCommand,
  validateInboundConnection,
  inboundConnectionExecutor
} from "../apps/api/dist-test/inbound-connection.js";
import { reconcileCoordinatedCallCleanup } from "../apps/api/dist-test/call-cleanup.js";
import { createCallCoordinationRuntime } from "../apps/api/dist-test/call-coordination-runtime.js";
import { registerDashboardRoutes } from "../apps/api/dist-test/dashboard/routes.js";
import { startFreeSwitchEventListener } from "../apps/api/dist-test/esl-events.js";
import { isFreeSwitchEventListenerSubscribed } from "../apps/api/dist-test/esl-listener-state.js";
import {
  checkCutoverDatabase,
  checkCutoverJournal,
  checkCutoverSwitch,
  finishCallCoordinationCutover
} from "../apps/api/dist-test/coordination-cutover.js";
const directory = process.argv[2];
const i03 = process.argv[3] === "--i03-load";
const mixed = process.argv[3] === "--i03-mixed";
const soak = process.argv[3] === "--i03-soak" ? process.argv[4] : undefined;
const i05 = process.env.I05_RUNTIME === "1";
assert.match(directory ?? "", /^\/tmp\/outbound-e02\.[A-Za-z0-9]+$/);
const socket = join(directory, "agent.sock");
const config = {
  CALL_RECORDINGS_STORAGE_DIR: join(directory, "recordings"),
  FREESWITCH_ESL_ENABLED: true,
  FREESWITCH_INBOUND_CONFIG_ENABLED: true,
  FREESWITCH_ESL_HOST: "127.0.0.1",
  FREESWITCH_ESL_PORT: 8021,
  FREESWITCH_ESL_PASSWORD: "a02-disposable-only",
  FREESWITCH_GENERATED_CONFIG_DIR: join(directory, "generated"),
  FREESWITCH_INBOUND_TRUSTED_CIDRS: "127.0.0.2/32",
  FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT: soak || mixed || i05 ? 8 : 2,
  FREESWITCH_TRUNK_CHANNEL_LIMIT: soak || mixed || i05 ? 40 : 4,
  FREESWITCH_INBOUND_WAIT_SECONDS: 3
};
const esl = {
  host: "127.0.0.1",
  port: 8021,
  password: config.FREESWITCH_ESL_PASSWORD,
  fenced: Boolean(soak) || process.env.H01_RECOVERY === "1"
};
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  boundary:
    "Real product entrypoint/Lua/journal/PostgreSQL/C03/ESL adapter and UDP SIP/RTP; explicitly injected staged coordinators and real E02 acceptance API; no browser/provider/production"
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
const command = async (text) => {
  const body = (await sendFreeSwitchApiCommand(config, text)).body.trim();
  if (soak) {
    report.commandCount = (report.commandCount ?? 0) + 1;
    // The sustained report keeps per-call evidence and FreeSWITCH logs live on disk.
    // Repeated native discovery replies can exceed the size of a JSON string.
    if (report.commands.length === 32) report.commands.shift();
  }
  report.commands.push({ text, body });
  return body;
};
async function pass(name, evidence = {}) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
let f,
  app,
  agent,
  observer,
  limited,
  timer,
  phone,
  outboundTarget,
  eventError,
  draining = false,
  cursor = 0,
  consumedFrames = 0,
  transferRuntime;
const log = await open(join(directory, "agent.log"), "a");
let inflight;
let coordinated, stopDispatcher, stopListener;
let productRecoveryOwnsEvents = false;
const omittedRecoveryCalls = new Set();
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (cursor < observer.eventFrames.length) {
      try {
        if (
          !productRecoveryOwnsEvents &&
          !omittedRecoveryCalls.has(observer.eventFrames[cursor].headers["variable_outbound_dialer_call_id"])
        )
          await adapter.persistFreeSwitchEvent(config, f.pool, observer.eventFrames[cursor]);
        cursor++;
      } catch (error) {
        if (!adapter.isTransientPersistenceError(error)) throw error;
        report.eventRetries = (report.eventRetries ?? 0) + 1;
        await delay(10);
      }
    }
  } catch (e) {
    eventError = e;
  } finally {
    if (soak && cursor >= 512) {
      consumedFrames += cursor;
      observer.eventFrames.splice(0, cursor);
      observer.events.splice(0, cursor);
      cursor = 0;
    }
    draining = false;
  }
}
function recoveryTicket() {
  const isCurrent = () =>
    observer.connected && !eventError && !draining && cursor === observer.eventFrames.length;
  if (!isCurrent()) return null;
  const revision = consumedFrames + cursor;
  return () => isCurrent() && revision === consumedFrames + cursor;
}
async function checked(fn) {
  if (eventError) throw eventError;
  return fn();
}
const call = (id) => f.pool.query("select * from calls where id=$1", [id]).then((r) => r.rows[0]);
async function clean(id) {
  await until(
    () =>
      checked(async () => {
        try {
          if (transferRuntime) await transferRuntime.reconcile();
          await reconcileCoordinatedCallCleanup(f.pool, id);
        } catch (error) {
          if (!adapter.isTransientPersistenceError(error)) throw error;
          return false;
        }
        return (
          (
            await f.pool.query(
              "select count(*)::int as n from call_capacity_reservations where call_id=$1 and state<>'released'",
              [id]
            )
          ).rows[0].n === 0
        );
      }),
    `cleanup ${id}`
  );
}
async function startCall(caller = "+14155550199") {
  const before = new Set((await readIngressRecords(socket)).map((r) => r.uuid));
  let control;
  const result = invite({
    port: 5090,
    frequency: 880,
    caller,
    timeoutMs: 45000,
    control: (c) => (control = c)
  });
  result.catch(() => {});
  inflight = result;
  await until(
    async () => (await readIngressRecords(socket)).some((r) => !before.has(r.uuid)),
    "native durable capture"
  );
  const row = (await readIngressRecords(socket)).find((r) => !before.has(r.uuid));
  return { row, result, control };
}
try {
  await until(
    async () => {
      try {
        if (f) report.finalSnapshot = await f.snapshot();
        observer?.close();
        observer = await openEsl();
        return /internal-webrtc.*RUNNING/.test(await command("sofia status"));
      } catch {
        return false;
      }
    },
    "FS startup",
    30000
  );
  await observer.command(`event plain ${adapter.eventNames}`);
  report.fs = await command("version");
  const database = {
    host: join(directory, "socket"),
    database: "e02",
    user: "postgres",
    connectionTimeoutMillis: 2000
  };
  f = await cleanupFixture(database, {
    onPoolError: () => {
      report.databaseDisconnectObserved = true;
    }
  });
  limited = await limitedExecutor(f, database);
  if (process.env.H02_RECORDINGS === "1")
    await f.pool.query("update campaigns set call_recording_enabled=true where id=$1", [f.campaignId]);
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const queue = (await f.pool.query("select id from inbound_queues limit 1")).rows[0].id;
  await f.pool.query("update inbound_queues set queue_timeout_ms=18000 where id=$1", [queue]);
  const {
    rows: [number]
  } = await f.pool.query(
    "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values('+12025550100','E02',$1,true) returning id",
    [queue]
  );
  assert.equal(await new InboundConfigurationPublisher(f.pool, config).reconcile(), "applied");
  if (soak === "history") await prefillSoakHistory(f, directory, queue, number.id);
  agent = fork(new URL("../apps/api/dist-test/ingress-agent.js", import.meta.url), [], {
    env: {
      FREESWITCH_INGRESS_ENABLED: "true",
      FREESWITCH_INGRESS_SOCKET: socket,
      FREESWITCH_INGRESS_JOURNAL_SLOTS: soak ? "128" : "8",
      FREESWITCH_ESL_PASSWORD: esl.password
    },
    stdio: ["ignore", log.fd, log.fd, "ipc"]
  });
  await writeFile(join(directory, "journal-agent.pid"), String(agent.pid));
  await until(async () => {
    try {
      return !!JSON.parse(await ingressRequest(socket, "/status"));
    } catch {
      return false;
    }
  }, "journal startup");
  cursor = observer.eventFrames.length;
  timer = setInterval(() => void drain(), 10);
  const coordinator = createInboundQueueCoordinator(f.pool, socket, command, limited.executor, esl);
  const recover = async (work = coordinator.reconcile) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt === 2 || !adapter.isTransientPersistenceError(error)) throw error;
      }
    }
  };

  const username = `desk_${randomUUID().replaceAll("-", "")}`;
  phone = await endpoint({ username, password: "fixture", source: "127.0.0.3", frequency: 660 });
  await f.pool.query(
    "update agent_desk_sessions set sip_username=$2,actor_auth_version=1,verified_endpoint=$3,endpoint_pin=$3,verified_at=clock_timestamp() where id=$1",
    [f.input.deskSessionId, username, `sofia/internal-webrtc/sip:${username}@${phone.address}`]
  );
  const runtime = inboundConnectionExecutor(f.pool, limited.executor, esl);
  app = Fastify();
  const httpConfig = {
    ...config,
    JWT_SECRET: "e02-disposable-signing-secret-32-characters",
    JWT_EXPIRES_SECONDS: 3600,
    PUBLIC_APP_URL: "https://e02.example.test",
    corsOrigins: []
  };
  if (i05) {
    productRecoveryOwnsEvents = true;
    outboundTarget = await endpoint({ username: "12025550142", source: "127.0.0.4", frequency: 770 });
    const uri = new URL("postgresql://postgres@localhost/e02");
    uri.searchParams.set("host", database.host);
    uri.searchParams.set("options", `-c search_path=${f.schema}`);
    const executorUri = new URL(uri);
    executorUri.username = limited.database.user;
    executorUri.password = limited.database.password;
    Object.assign(httpConfig, {
      DATABASE_URL: uri.href,
      CALL_EXECUTOR_DATABASE_URL: executorUri.href,
      CALL_COORDINATION_ENABLED: true,
      FREESWITCH_INGRESS_ENABLED: true,
      FREESWITCH_INGRESS_SOCKET: socket,
      FREESWITCH_DOMAIN: "a04.invalid",
      FREESWITCH_MAX_SESSIONS: 80,
      FREESWITCH_TRUNK_JITTER_BUFFER_MSEC: "off",
      SIP_TRUNK_MODE: "ip_auth",
      SIP_TRUNK_PROXY: outboundTarget.address,
      SIP_TRUNK_CALLER_ID: "+12025550199",
      DEFAULT_PHONE_COUNTRY_CODE: "US",
      CONTACT_MAX_ATTEMPTS: 3,
      CONTACT_RETRY_DELAY_SECONDS: 900,
      FREESWITCH_ESL_EVENT_QUEUE_MAX_SIZE: 1024,
      FREESWITCH_ESL_EVENT_RETRY_INITIAL_MS: 25,
      FREESWITCH_ESL_EVENT_RETRY_MAX_MS: 500,
      FREESWITCH_ESL_RECONCILE_INTERVAL_SECONDS: 60
    });
    coordinated = await createCallCoordinationRuntime(f.pool, httpConfig);
    registerDashboardRoutes(
      app,
      httpConfig,
      f.pool,
      undefined,
      coordinated.outbound,
      coordinated.controls,
      coordinated.supervisor,
      coordinated.connection,
      coordinated.transfer
    );
    const logger = {
      info() {},
      warn(_details, message) {
        console.warn(message);
      },
      error(details, message) {
        console.error(message, details?.code ?? "");
      }
    };
    stopListener = startFreeSwitchEventListener(httpConfig, f.pool, logger, coordinated.recovery);
    stopDispatcher = coordinated.startDispatcher((error) => console.warn(error.message));
    await until(isFreeSwitchEventListenerSubscribed, "production ESL listener subscription");
    report.boundary =
      "Production coordination bootstrap and HTTP routes with isolated real PostgreSQL, FreeSWITCH, ingress journal and UDP SIP/RTP. Desk endpoint is fixture-bound.";
  } else {
    registerCallOfferRoutes(app, httpConfig, f.pool, {
      async wakeExecutor() {
        /* controlled wake: HTTP must finish before native work */
      }
    });
  }
  const token = signAuthToken(httpConfig, {
    sub: f.userId,
    email: "e02@example.test",
    role: "agent",
    ver: 1
  });
  const headers = { authorization: `Bearer ${token}` };
  const intent = () => ({
    deskSessionId: f.input.deskSessionId,
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  });
  async function offerFor(c) {
    await recover();
    await f.pool.query("update agents set availability_status='available' where id=$1", [f.agentId]);
    await f.pool.query("update agent_desk_sessions set verified_at=clock_timestamp() where id=$1", [
      f.input.deskSessionId
    ]);
    const offer = await dispatchInboundOffers(f.pool, f.agentId);
    assert.equal(offer?.callId, c.row.uuid);
    return offer;
  }
  async function accept(c) {
    const offer = await offerFor(c),
      payload = intent(),
      url = `/agent/call-offers/${offer.id}/accept`;
    const response = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.status, "connecting");
    assert.equal((await call(c.row.uuid)).agent_connected_at, null);
    return { offer, payload, url, result };
  }
  if (i05) {
    const c = await startCall();
    const deskURL = `/agent/desk?campaignId=${f.campaignId}`;
    const pending = await until(async () => {
      const response = await app.inject({ method: "GET", url: deskURL, headers });
      assert.equal(response.statusCode, 200, response.body);
      const { offer } = response.json().coordination;
      return offer?.callId === c.row.uuid && offer;
    }, "production dispatcher publishes the inbound offer");
    const response = await app.inject({
      method: "POST",
      url: `/agent/call-offers/${pending.id}/accept`,
      headers,
      payload: intent()
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, "connecting");
    await until(
      async () => (await call(c.row.uuid))?.state === "agent_connected",
      "production executor bridge"
    );
    const active = (await app.inject({ method: "GET", url: deskURL, headers })).json();
    assert.equal(active.coordination.slot.callId, c.row.uuid);
    assert.equal(active.activeCall.id, c.row.uuid);
    assert.equal(phone.invites.length, 1);
    await until(() => phone.received.length >= 2400, "agent receives customer RTP");
    const reverseTone = assertTone(phone.received.slice(-2400), 880);
    c.control.hangup();
    const media = await c.result;
    const forwardTone = assertTone(
      media.rtp.slice(-15).flatMap((p) => p.payload.map(decodeUlaw)),
      660
    );
    await until(async () => {
      const row = await call(c.row.uuid);
      return (
        row?.ended_at &&
        (
          await f.pool.query(
            `select 1 from agent_call_slots where agent_id=$1 and state='free'
        and not exists(select 1 from call_operations where call_id=$2 and resolved_at is null)
        and not exists(select 1 from call_capacity_reservations where call_id=$2 and state<>'released')`,
            [f.agentId, c.row.uuid]
          )
        ).rowCount === 1
      );
    }, "production listener completes terminal and releases capacity");
    await pass("I05 coordinated bootstrap admits, offers, bridges and releases a real inbound call", {
      callId: c.row.uuid,
      operationId: response.json().operationId,
      forwardTone,
      reverseTone
    });
    await provisionAgentDirectory(httpConfig, {
      sipUsername: username,
      sipPassword: "fixture",
      displayName: "I05"
    });
    await reloadAgentDirectories(httpConfig);
    await phone.register();
    const pinned = await command(`sofia_contact internal-webrtc/${username}@a04.invalid`);
    await f.pool.query(
      "update agent_desk_sessions set verified_endpoint=$2,endpoint_pin=$2,verified_at=clock_timestamp() where id=$1",
      [f.input.deskSessionId, pinned]
    );
    await f.pool.query("update agents set registered=false where id=$1", [f.agentId]);
    phone.received.length = 0;
    const outbound = await app.inject({
      method: "POST",
      url: "/agent/manual-dial/start",
      headers,
      payload: {
        campaignId: f.campaignId,
        phoneNumber: "+12025550142",
        intent: { ...intent(), startReason: "manual" }
      }
    });
    assert.equal(outbound.statusCode, 200, outbound.body);
    const outboundId = outbound.json().callId;
    await until(async () => (await call(outboundId))?.state === "bridged", "coordinated outbound bridge");
    await until(
      () => phone.received.length >= 2400 && outboundTarget.received.length >= 2400,
      "outbound RTP"
    );
    const outboundAgentTone = assertTone(phone.received.slice(-2400), 770);
    const outboundCustomerTone = assertTone(outboundTarget.received.slice(-2400), 660);
    const ended = await app.inject({
      method: "POST",
      url: `/agent/calls/${outboundId}/end`,
      headers,
      payload: { intent: intent() }
    });
    assert.equal(ended.statusCode, 200, ended.body);
    await until(async () => (await call(outboundId))?.ended_at, "terminal coordinated outbound");
    await pass("I05 coordinated outbound uses the verified Desk binding, carries audio and hangs up", {
      callId: outboundId,
      operationId: outbound.json().operationId,
      outboundAgentTone,
      outboundCustomerTone
    });
    await f.pool.query("update inbound_numbers set enabled=false where id=$1", [number.id]);
    await f.pool.query(
      "insert into system_settings(key,value_json) values('ops.call_start_paused','true') on conflict(key) do update set value_json='true'"
    );
    assert.equal(await new InboundConfigurationPublisher(f.pool, httpConfig).reconcile(), "applied");
    await until(async () => {
      try {
        await checkCutoverDatabase(f.pool);
        await checkCutoverJournal(httpConfig);
        return true;
      } catch {
        return false;
      }
    }, "production drain, native receipt ACK and ingress journal ACK");
    await checkCutoverSwitch(httpConfig);
    stopDispatcher();
    stopListener();
    await coordinated.close();
    coordinated = undefined;
    await finishCallCoordinationCutover(f.pool, false);
    assert.equal(
      await createCallCoordinationRuntime(f.pool, { ...httpConfig, CALL_COORDINATION_ENABLED: false }),
      null
    );
    assert.equal((await call(c.row.uuid)).outcome, "customer_hung_up");
    await pass("I05 deactivation preserves completed history and admits the feature-off API mode", {
      callId: c.row.uuid
    });
  } else if (soak) {
    await runSipRtpSoak({
      profile: soak,
      f,
      config: httpConfig,
      esl,
      directory,
      socket,
      limited,
      coordinator,
      recover,
      command,
      clean,
      recoveryTicket,
      pass
    });
  } else if (mixed) {
    await runSipRtpMixed({
      f,
      socket,
      config: httpConfig,
      app,
      limited,
      esl,
      command,
      recover,
      runtime,
      clean,
      pass
    });
  } else if (i03) {
    await runSipRtpLoad({ app, f, config: httpConfig, command, startCall, recover, clean, runtime, pass });
  } else if (process.env.H01_MATRIX_ONLY !== "1") {
    const c = await startCall();
    const accepted = await accept(c);
    const before = phone.invites.length;
    assert.deepEqual(
      (await app.inject({ method: "POST", url: accepted.url, headers, payload: accepted.payload })).json(),
      accepted.result
    );
    await runtime.wakeExecutor(accepted.result.operationId);
    await until(async () => (await call(c.row.uuid)).state === "agent_connected", "native accepted bridge");
    const connected = await call(c.row.uuid);
    assert.equal(phone.invites.length - before, 1);
    const root = (
      await f.pool.query("select * from call_operations where id=$1", [accepted.result.operationId])
    ).rows[0];
    assert.equal(await command(`uuid_exists ${root.request.agentUuid}`), "true");
    assert.equal(
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0].state,
      "active"
    );
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int n from call_capacity_reservations where call_id=$1 and resource_type='queue_waiting' and state<>'released'",
          [c.row.uuid]
        )
      ).rows[0].n,
      0
    );
    await runtime.wakeExecutor(accepted.result.operationId);
    assert.equal(phone.invites.length - before, 1);
    await pass(
      "E02.1/E02.3 real HTTP winner, fixed originate/bridge, duplicate request/event replay and distinct bridge clock",
      { response: accepted.result, connected, agentUuid: root.request.agentUuid }
    );
    await until(() => phone.received.length >= 2400, "agent receives customer RTP");
    const reverseTone = assertTone(phone.received.slice(-2400), 880);
    if (process.env.G02_TRANSFERS === "1")
      transferRuntime = await proveTransferExecution({ f, c, phone, command, pass, limited });
    if (process.env.G01_TRANSFERS === "1")
      await proveTransferSourceContinuity({ f, c, phone, command, pass });
    await delay(400);
    await until(
      () => Date.now() > connected.queue_deadline_at.getTime() + 150,
      "original queue deadline passed",
      20000
    );
    assert.equal((await call(c.row.uuid)).ended_at, null);
    assert.equal(await command(`uuid_exists ${c.row.uuid}`), "true");
    await pass("E02 confirmed bridge cancels the original queue hangup guard", {
      originalDeadline: connected.queue_deadline_at
    });
    c.control.hangup();
    const media = await c.result;
    if (transferRuntime) await transferRuntime.reconcile();
    const tone = assertTone(
      media.rtp.slice(-15).flatMap((p) => p.payload.map(decodeUlaw)),
      660
    );
    await runtime.reconcile();
    await clean(c.row.uuid);
    await recover();
    if (transferRuntime?.recording)
      await pass(
        "H02.1 inbound retained customer recording across A-B-A transfer",
        await transferRuntime.recording.finish()
      );
    await pass("E02 actual winner stops waiting tone and passes decoded agent-to-customer media", {
      tone,
      reverseTone,
      invites: phone.invites.length - before
    });

    if (process.env.G02_TRANSFERS === "1")
      await proveOutboundTransferExecution({ f, phone, command, limited, pass });
    if (process.env.H01_RECOVERY === "1")
      await proveQuiescentRecovery({
        f,
        phone,
        command,
        limited,
        pass,
        omit: omittedRecoveryCalls,
        async persisted() {
          await until(async () => {
            await drain();
            return !draining && cursor === observer.eventFrames.length;
          }, "H01 fixture persistence drained");
          if (eventError) throw eventError;
        }
      });
    if (process.env.G02_TRANSFERS === "1" && process.env.H02_RECORDINGS !== "1") {
      for (const direction of ["inbound", "outbound"])
        for (const lossBoundary of [
          "customer_terminal_before_originate",
          "before_originate",
          "before_park",
          "after_park",
          "after_bridge"
        ]) {
          await proveOutboundTransferExecution({ f, phone, command, limited, pass, direction, lossBoundary });
        }
    }
    const early = await startCall(),
      earlyOffer = await offerFor(early),
      earlyInput = intent();
    let releaseHttp;
    const httpGate = new Promise((resolve) => (releaseHttp = resolve)),
      earlyApp = Fastify();
    earlyApp.addHook("onSend", async (_request, _reply, payload) => {
      await httpGate;
      return payload;
    });
    registerCallOfferRoutes(earlyApp, httpConfig, f.pool, runtime);
    try {
      const count = phone.invites.length;
      const pending = earlyApp
        .inject({
          method: "POST",
          url: `/agent/call-offers/${earlyOffer.id}/accept`,
          headers,
          payload: earlyInput
        })
        .then((r) => r);
      const duplicate = earlyApp
        .inject({
          method: "POST",
          url: `/agent/call-offers/${earlyOffer.id}/accept`,
          headers,
          payload: earlyInput
        })
        .then((r) => r);
      await until(
        async () => (await call(early.row.uuid)).state === "agent_connected",
        "service INVITE/bridge before held HTTP response"
      );
      const replay = await acceptInboundOffer(
        f.pool,
        { userId: f.userId, agentId: f.agentId, authVersion: 1 },
        earlyOffer.id,
        earlyInput
      );
      releaseHttp();
      const response = await pending;
      assert.deepEqual((await duplicate).json(), response.json());
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), replay);
      assert.equal(response.json().status, "connecting");
      assert.equal(phone.invites.length - count, 1);
      await until(
        async () =>
          (
            await f.pool.query("select settled_at from inbound_connection_attempts where offer_id=$1", [
              earlyOffer.id
            ])
          ).rows[0]?.settled_at,
        "early response chain settlement"
      );
      early.control.hangup();
      await early.result;
      await clean(early.row.uuid);
      await recover();
      await pass(
        "E02.3 actual INVITE and bridge before delayed HTTP response; replay keeps one fixed operation",
        { response: response.json(), invites: phone.invites.length - count }
      );
    } finally {
      releaseHttp();
      await earlyApp.close();
    }
    // Real delayed transport and lost ACK, including absence before the send.
    const lost = await startCall(),
      lostAccept = await accept(lost);
    const lostRoot = (
      await f.pool.query("select * from call_operations where id=$1", [lostAccept.result.operationId])
    ).rows[0];
    const transport = await relay();
    try {
      const faultDriver = createCommandDriver({
        ...esl,
        port: transport.port,
        buildCommand: inboundConnectionCommand,
        validate: validateInboundConnection,
        verify: async () => null,
        reconcile: async () => null
      });
      const sendsBefore = phone.invites.length;
      const running = limited.executor.run(lostRoot.id, "normal", faultDriver);
      await until(() => transport.queued, "actual originate bytes held");
      assert.equal(await command(`uuid_exists ${lostRoot.request.agentUuid}`), "false");
      assert.equal(await settleInboundConnection(f.pool, lostRoot.id), null);
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
          .state,
        "connecting"
      );
      assert.deepEqual(
        (
          await app.inject({ method: "POST", url: lostAccept.url, headers, payload: lostAccept.payload })
        ).json(),
        lostAccept.result
      );
      transport.forward();
      await until(
        () =>
          observer.events.some(
            (e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === lostRoot.command_uuid
          ),
        "fixed originate job despite lost ACK"
      );
      await transport.close();
      assert.equal((await running).status, "uncertain");
      await runtime.wakeExecutor(lostRoot.id);
      await until(async () => {
        await runtime.reconcile();
        return (await call(lost.row.uuid)).state === "agent_connected";
      }, "lost-ACK event backlog resolves same connection");
      assert.equal((await call(lost.row.uuid)).state, "agent_connected");
      assert.equal(phone.invites.length - sendsBefore, 1);
      lost.control.hangup();
      await lost.result;
      await clean(lost.row.uuid);
      await recover();
      await pass(
        "E02.3 real held bytes, false initial absence, lost ACK and HTTP replay recover the same operation once",
        { sends: transport.sends, operationId: lostRoot.id }
      );
    } finally {
      await transport.close().catch(() => {});
    }

    let releaseAnswer;
    const answerGate = new Promise((resolve) => (releaseAnswer = resolve));
    phone.setBehavior({ answerGate });
    const interrupted = await startCall(),
      interruptedAccept = await accept(interrupted),
      invitesBefore = phone.invites.length;
    const connecting = runtime.wakeExecutor(interruptedAccept.result.operationId);
    await until(() => phone.invites.length > invitesBefore, "real agent INVITE awaiting controlled answer");
    interrupted.control.hangup();
    await interrupted.result;
    await until(
      async () => !!(await call(interrupted.row.uuid)).ended_at,
      "customer terminal during originate"
    );
    assert.notEqual(
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0].state,
      "free"
    );
    releaseAnswer();
    await connecting;
    await until(async () => {
      await runtime.reconcile();
      return (
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
          .state === "free"
      );
    }, "exact cleanup before slot reuse");
    assert.equal((await call(interrupted.row.uuid)).agent_connected_at, null);
    await clean(interrupted.row.uuid);
    await recover();
    await pass(
      "E02.2/E02.4 customer hangup during connection and late answer retain slot until fixed-job/leg cleanup"
    );

    phone.setBehavior({ rejectCode: 486 });
    const rejected = await startCall();
    const rejectedBefore = phone.invites.length;
    let original;
    const attempts = [];
    for (let n = 1; n <= 3; n++) {
      const accepted = await accept(rejected);
      original ??= await call(rejected.row.uuid);
      await runtime.wakeExecutor(accepted.result.operationId);
      await until(async () => {
        await runtime.reconcile();
        return (await call(rejected.row.uuid)).state !== "connecting";
      }, "rejected job and terminal events settle before reuse");
      const current = await call(rejected.row.uuid);
      assert.equal(current.queue_deadline_at.getTime(), original.queue_deadline_at.getTime());
      assert.equal(current.arrived_at.getTime(), original.arrived_at.getTime());
      assert.equal(current.agent_connected_at, null);
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
          .state,
        "free"
      );
      const x = (
        await f.pool.query("select * from inbound_connection_attempts where operation_id=$1", [
          accepted.result.operationId
        ])
      ).rows[0];
      attempts.push(x);
      if (n < 3) {
        assert.equal(current.state, "queued");
        assert.equal(await dispatchInboundOffers(f.pool, f.agentId), null);
        await until(
          async () =>
            (
              await f.pool.query(
                "select retry_at<=clock_timestamp() due from inbound_connection_attempts where operation_id=$1",
                [accepted.result.operationId]
              )
            ).rows[0].due,
          "fixed backoff"
        );
      } else assert.equal(current.state, "fallback");
    }
    assert.equal(phone.invites.length - rejectedBefore, 3);
    rejected.control.hangup();
    await rejected.result;
    await clean(rejected.row.uuid);
    await recover();
    await pass(
      "E02.4 three actual rejected SIP connects, fixed backoff, retained queue permit, unchanged deadline and bounded fallback",
      { attempts, invites: phone.invites.length - rejectedBefore }
    );

    let canceledInvites = 0;
    phone.setBehavior({ answerGate: new Promise(() => {}), onCancel: () => canceledInvites++ });
    const unanswered = await startCall();
    const unansweredAccept = await accept(unanswered);
    const unansweredRoot = (
      await f.pool.query("select * from call_operations where id=$1", [unansweredAccept.result.operationId])
    ).rows[0];
    const originalQueue = await call(unanswered.row.uuid);
    const beforeTimeout = phone.invites.length;
    const began = performance.now();
    await runtime.wakeExecutor(unansweredRoot.id);
    const settled = await until(
      async () => {
        await runtime.reconcile();
        const attempt = (
          await f.pool.query("select * from inbound_connection_attempts where operation_id=$1", [
            unansweredRoot.id
          ])
        ).rows[0];
        return attempt.settled_at ? attempt : null;
      },
      "unanswered inbound connection settles after fixed SIP cleanup",
      15000
    );
    const elapsedMs = performance.now() - began;
    assert.ok(canceledInvites > 0, "FreeSWITCH canceled the ringing SIP recipient");
    assert.equal(new Set(phone.invites.slice(beforeTimeout).map((invite) => invite.id)).size, 1);
    assert.equal(await command(`uuid_exists ${unansweredRoot.request.agentUuid}`), "false");
    const afterTimeout = await call(unanswered.row.uuid);
    assert.equal(afterTimeout.agent_connected_at, null);
    assert.equal(afterTimeout.ended_at, null);
    assert.equal(afterTimeout.queue_deadline_at.getTime(), originalQueue.queue_deadline_at.getTime());
    unanswered.control.hangup();
    await unanswered.result;
    await clean(unanswered.row.uuid);
    await recover();
    await pass("I02.1 unanswered inbound agent leg times out without changing the caller deadline", {
      callId: unanswered.row.uuid,
      operationId: unansweredRoot.id,
      agentUuid: unansweredRoot.request.agentUuid,
      canceledInvites,
      settled: settled.outcome,
      elapsedMs
    });
    phone.setBehavior();
  }
  if (process.env.H01_RECOVERY === "1") {
    productRecoveryOwnsEvents = true;
    while (draining) await delay(10);
    await proveLifecycleRecovery({
      f,
      limited,
      directory,
      socket,
      esl,
      config,
      phone,
      command,
      pass,
      startCall,
      accept,
      async restartJournal(duringStop) {
        const exit = once(agent, "exit");
        agent.kill("SIGKILL");
        await exit;
        await duringStop?.();
        agent = fork(new URL("../apps/api/dist-test/ingress-agent.js", import.meta.url), [], {
          env: {
            FREESWITCH_INGRESS_ENABLED: "true",
            FREESWITCH_INGRESS_SOCKET: socket,
            FREESWITCH_INGRESS_JOURNAL_SLOTS: "8",
            FREESWITCH_ESL_PASSWORD: esl.password
          },
          stdio: ["ignore", log.fd, log.fd, "ipc"]
        });
        await writeFile(join(directory, "journal-agent.pid"), String(agent.pid));
        await until(async () => {
          try {
            return !!JSON.parse(await ingressRequest(socket, "/status"));
          } catch {
            return false;
          }
        }, "H01 journal restart");
      }
    });
  }
  if (!soak) {
    report.snapshot = await f.snapshot();
    assert.equal(report.snapshot.call_capacity_reservations.filter((r) => r.state !== "released").length, 0);
    assert.equal(report.snapshot.call_operations.filter((r) => !r.resolved_at).length, 0);
    assert.equal(report.snapshot.agent_call_slots.filter((r) => r.state !== "free").length, 0);
  }
  // CHANNEL_DESTROY persistence can precede final removal from FS channel tables.
  // Require bounded observed convergence; never kill a channel to make this pass.
  await until(
    async () => JSON.parse(await command("show channels as json")).row_count === 0,
    "all actual channels removed",
    5000
  );
  if (eventError) throw eventError;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  await save();
  if (process.env.G02_TRANSFERS === "1") await command("hupall NORMAL_CLEARING");
  throw error;
} finally {
  await app?.close();
  stopDispatcher?.();
  stopListener?.();
  await coordinated?.close();
  if (timer) clearInterval(timer);
  while (draining) await delay(10);
  if (f && !soak) report.finalSnapshot = await f.snapshot();
  observer?.close();
  await phone?.close();
  await outboundTarget?.close();
  if (agent) {
    const exit = once(agent, "exit");
    agent.kill("SIGTERM");
    await exit;
    await rm(join(directory, "journal-agent.pid"), { force: true });
  }
  await limited?.close();
  if (f) {
    await f.cleanup();
    if (i03 || soak || mixed) report.cleanup = "schema removed";
  }
  await inflight?.catch(() => {});
  await log.close();
  await save();
}
