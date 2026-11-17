import { proveTransferExecution, proveOutboundTransferExecution } from "./g02-transfer-execution.mjs";
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
const directory = process.argv[2];
assert.match(directory ?? "", /^\/tmp\/outbound-e02\.[A-Za-z0-9]+$/);
const socket = join(directory, "agent.sock");
const config = {
  FREESWITCH_ESL_ENABLED: true,
  FREESWITCH_INBOUND_CONFIG_ENABLED: true,
  FREESWITCH_ESL_HOST: "127.0.0.1",
  FREESWITCH_ESL_PORT: 8021,
  FREESWITCH_ESL_PASSWORD: "a02-disposable-only",
  FREESWITCH_GENERATED_CONFIG_DIR: join(directory, "generated"),
  FREESWITCH_INBOUND_TRUSTED_CIDRS: "127.0.0.2/32",
  FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT: 2,
  FREESWITCH_TRUNK_CHANNEL_LIMIT: 4,
  FREESWITCH_INBOUND_WAIT_SECONDS: 3
};
const esl = { host: "127.0.0.1", port: 8021, password: config.FREESWITCH_ESL_PASSWORD };
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
  report.commands.push({ text, body });
  return body;
};
async function pass(name, evidence = {}) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
let f,
  agent,
  observer,
  limited,
  timer,
  phone,
  eventError,
  draining = false,
  cursor = 0,
  transferRuntime;
const log = await open(join(directory, "agent.log"), "a");
let inflight;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (cursor < observer.eventFrames.length) {
      try {
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
    draining = false;
  }
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
  f = await cleanupFixture(database);
  limited = await limitedExecutor(f, database);
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const queue = (await f.pool.query("select id from inbound_queues limit 1")).rows[0].id;
  await f.pool.query("update inbound_queues set queue_timeout_ms=18000 where id=$1", [queue]);
  await f.pool.query(
    "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values('+12025550100','E02',$1,true)",
    [queue]
  );
  assert.equal(await new InboundConfigurationPublisher(f.pool, config).reconcile(), "applied");
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
  }, "journal startup");
  cursor = observer.eventFrames.length;
  timer = setInterval(() => void drain(), 10);
  const coordinator = createInboundQueueCoordinator(f.pool, socket, command, limited.executor, esl);
  const recover = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await coordinator.reconcile();
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
  const app = Fastify();
  const httpConfig = {
    ...config,
    JWT_SECRET: "e02-disposable-signing-secret-32-characters",
    JWT_EXPIRES_SECONDS: 3600,
    PUBLIC_APP_URL: "https://e02.example.test",
    corsOrigins: []
  };
  registerCallOfferRoutes(app, httpConfig, f.pool, {
    async wakeExecutor() {
      /* controlled wake: HTTP must finish before native work */
    }
  });
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
  if (process.env.G01_TRANSFERS === "1") await proveTransferSourceContinuity({ f, c, phone, command, pass });
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
  await pass("E02 actual winner stops waiting tone and passes decoded agent-to-customer media", {
    tone,
    reverseTone,
    invites: phone.invites.length - before
  });

  if (process.env.G02_TRANSFERS === "1")
    await proveOutboundTransferExecution({ f, phone, command, limited, pass });
  if (process.env.G02_TRANSFERS === "1") {
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
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0].state,
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
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0].state,
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
  phone.setBehavior();
  await app.close();
  report.snapshot = await f.snapshot();
  assert.equal(report.snapshot.call_capacity_reservations.filter((r) => r.state !== "released").length, 0);
  assert.equal(report.snapshot.call_operations.filter((r) => !r.resolved_at).length, 0);
  assert.equal(report.snapshot.agent_call_slots.filter((r) => r.state !== "free").length, 0);
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
  if (timer) clearInterval(timer);
  while (draining) await delay(10);
  if (f) report.finalSnapshot = await f.snapshot();
  observer?.close();
  await phone?.close();
  if (agent) {
    const exit = once(agent, "exit");
    agent.kill("SIGTERM");
    await exit;
    await rm(join(directory, "journal-agent.pid"), { force: true });
  }
  await limited?.close();
  if (f) report.cleanup = await f.cleanup();
  await inflight?.catch(() => {});
  await log.close();
  await save();
}
