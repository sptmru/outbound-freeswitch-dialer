import { runFallback } from "./f03-fallback-probe.mjs";
import assert from "node:assert/strict";
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
import { importIngressRecord } from "../apps/api/dist-test/inbound-ingress.js";
import { admitInboundQueue, createInboundQueueCoordinator } from "../apps/api/dist-test/inbound-queue.js";
import { ingressRequest, readIngressRecords } from "../apps/api/dist-test/ingress-agent.js";
import { __testing as adapter } from "../apps/api/dist-test/esl-events.js";
import { withCallAdmission } from "../apps/api/dist-test/call-admission.js";
import { enqueueCallCommand } from "../apps/api/dist-test/call-executor.js";
import { createCommandDriver } from "../apps/api/dist-test/call-command-transport.js";
import { reconcileCoordinatedCallCleanup } from "../apps/api/dist-test/call-cleanup.js";
import { runInboundAudioReplacement } from "./f02-audio-probe.mjs";
const directory = process.argv[2];
assert.match(directory ?? "", /^\/tmp\/outbound-d04\.[A-Za-z0-9]+$/);
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
    "Real product entrypoint/Lua/journal/PostgreSQL/C03/ESL adapter and UDP SIP/RTP; explicitly injected staged coordinator and E02 winner fixture; no browser/provider/production"
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
  cursor = 0;
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
    caller,
    timeoutMs: process.env.F03_FALLBACK === "1" ? 45000 : 17000,
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
    database: "d04",
    user: "postgres",
    connectionTimeoutMillis: 2000
  };
  f = await cleanupFixture(database);
  limited = await limitedExecutor(f, database);
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const queue = (await f.pool.query("select id from inbound_queues limit 1")).rows[0].id;
  await f.pool.query("update inbound_queues set queue_timeout_ms=15000 where id=$1", [queue]);
  await f.pool.query(
    "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values('+12025550100','D04',$1,true)",
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
  if (process.env.F03_FALLBACK === "1")
    await runFallback({
      f,
      queue,
      directory,
      config,
      startCall,
      recover,
      call,
      clean,
      checked,
      pass,
      executor: limited.executor,
      esl
    });
  if (process.env.F02_AUDIO === "1")
    await runInboundAudioReplacement({
      f,
      queue,
      directory,
      config,
      startCall,
      recover,
      call,
      clean,
      command,
      checked,
      pass
    });
  const contact = (
    await f.pool.query(
      "insert into contacts(campaign_id,display_name,phone_number,normalized_phone_number,status,attempt_count) values($1,'D04 known','+14155550199','+14155550199','new',2) returning *",
      [f.campaignId]
    )
  ).rows[0];
  for (const caller of ["+14155550199", "+14155550200", "anonymous"]) {
    const c = await startCall(caller);
    await recover();
    await until(
      () => checked(async () => Boolean((await call(c.row.uuid)).pstn_answered_at)),
      "waiting PSTN answer"
    );
    const waiting = await call(c.row.uuid);
    assert.equal(waiting.state, "queued");
    assert.equal(waiting.agent_connected_at, null);
    assert.equal(waiting.contact_id, null);
    assert.equal(waiting.inbound_context_contact_id, caller === "+14155550199" ? contact.id : null);
    await delay(400);
    c.control.hangup();
    const result = await c.result;
    assert.equal(result.final, 200);
    assert.ok(result.bye);
    assert.ok(result.audio.samples >= 1600);
    assert.ok(result.audio.frequencyHz > 420 && result.audio.frequencyHz < 460, JSON.stringify(result.audio));
    await until(() => checked(async () => Boolean((await call(c.row.uuid)).ended_at)), "customer terminal");
    await recover();
    await clean(c.row.uuid);
    await pass(`D04.2 known/unknown/withheld caller ${caller}`, {
      uuid: c.row.uuid,
      sip: result.final,
      audio: result.audio,
      waiting,
      terminal: await call(c.row.uuid)
    });
  }
  assert.deepEqual((await f.pool.query("select * from contacts where id=$1", [contact.id])).rows[0], contact);
  // Real CANCEL with committed capture/history, before queue admission.
  const pre = await startCall();
  await importIngressRecord(f.pool, pre.row);
  pre.control.cancel();
  const preResult = await pre.result;
  assert.equal(preResult.final, 487);
  assert.equal(preResult.rtp.length, 0);
  await until(
    () => checked(async () => Boolean((await call(pre.row.uuid)).ended_at)),
    "pre-admission CANCEL"
  );
  assert.equal((await call(pre.row.uuid)).inbound_end_reason, "caller_canceled_before_admission");
  await recover();
  assert.equal(
    (await f.pool.query("select count(*)::int as n from call_operations where call_id=$1", [pre.row.uuid]))
      .rows[0].n,
    0
  );
  await pass("D04.3 real CANCEL before queue admission", { uuid: pre.row.uuid, sip: preResult.final });
  const committed = await startCall();
  await importIngressRecord(f.pool, committed.row);
  await admitInboundQueue(f.pool, committed.row.uuid);
  committed.control.cancel();
  const cancelResult = await committed.result;
  assert.equal(cancelResult.final, 487);
  assert.equal(cancelResult.rtp.length, 0);
  await until(
    () => checked(async () => Boolean((await call(committed.row.uuid)).ended_at)),
    "post-commit CANCEL"
  );
  assert.equal((await call(committed.row.uuid)).inbound_end_reason, "caller_canceled_in_queue");
  await clean(committed.row.uuid);
  await recover();
  await pass("D04.3 real CANCEL after queue COMMIT before waiting sender", {
    uuid: committed.row.uuid,
    sip: cancelResult.final
  });
  // Keep one waiting channel under a one-call queue limit; reject only the newcomer.
  await f.pool.query("update inbound_queues set max_waiting_calls=1 where id=$1", [queue]);
  const kept = await startCall();
  await recover();
  assert.ok((await call(kept.row.uuid)).pstn_answered_at);
  const over = await startCall();
  await recover();
  const refused = await over.result;
  assert.equal(refused.final, 503);
  assert.equal(refused.rtp.length, 0);
  assert.equal((await call(over.row.uuid)).inbound_end_reason, "capacity_exceeded");
  assert.equal(await command(`uuid_exists ${kept.row.uuid}`), "true");
  assert.equal((await call(kept.row.uuid)).ended_at, null);
  kept.control.hangup();
  await kept.result;
  await clean(kept.row.uuid);
  await recover();
  await pass("D04.3 actual overflow refuses before answer and preserves admitted waiting call", {
    kept: kept.row.uuid,
    rejected: over.row.uuid,
    sip: refused.final
  });
  const bounded = await startCall();
  await recover();
  // Real native scheduler bound, independent of any API timeout/fallback worker.
  const boundedResult = await bounded.result;
  assert.equal(boundedResult.final, 200);
  assert.ok(boundedResult.bye);
  assert.ok(boundedResult.durationMs <= 16000);
  await until(
    () => checked(async () => Boolean((await call(bounded.row.uuid)).ended_at)),
    "queue deadline terminal"
  );
  assert.equal((await call(bounded.row.uuid)).inbound_end_reason, "queue_timeout");
  await clean(bounded.row.uuid);
  await recover();
  await pass("D04 native original queue deadline bounds waiting without fallback worker", {
    uuid: bounded.row.uuid,
    elapsedMs: boundedResult.durationMs
  });
  // E02 acceptance/agent originate are fixture-owned. D04 consumes concrete native
  // bridge evidence only after persisted accepted winner + exact slot/intent.
  const connected = await startCall();
  await recover();
  const agentUuid = randomUUID(),
    participant = randomUUID(),
    bridgeId = randomUUID();
  phone = await endpoint({ username: "d04-agent", password: "fixture", source: "127.0.0.3", frequency: 660 });
  await f.pool.query("update agent_desk_sessions set verified_at=clock_timestamp() where id=$1", [
    f.input.deskSessionId
  ]);
  const db = await f.pool.connect();
  try {
    await withCallAdmission(db, { callIds: [connected.row.uuid], agentIds: [f.agentId] }, async (a) => {
      await db.query(
        "insert into call_participants(id,call_id,role,agent_id,joined_at) values($1,$2,'agent',$3,clock_timestamp())",
        [participant, connected.row.uuid, f.agentId]
      );
      const slot = await a.reserve(f.input, connected.row.uuid, participant);
      await a.transition(slot, "connecting");
      await db.query(
        "insert into call_legs(call_id,participant_id,type,freeswitch_uuid,state,started_at) values($1,$2,'agent',$3,'started',clock_timestamp())",
        [connected.row.uuid, participant, agentUuid]
      );
      await db.query("update calls set state='connecting',agent_id=$2 where id=$1", [
        connected.row.uuid,
        f.agentId
      ]);
      await db.query(
        "insert into call_offers(call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at,state,closed_at,reason) values($1,'inbound',$2,1,$3,1,1,clock_timestamp()+interval '30 seconds','accepted',clock_timestamp(),'user_accepted')",
        [connected.row.uuid, f.agentId, f.input.deskSessionId]
      );
      await enqueueCallCommand(a, {
        id: bridgeId,
        callId: connected.row.uuid,
        scope: "d04-e02-bridge-fixture",
        key: bridgeId,
        fingerprint: "a".repeat(64),
        kind: "bridge",
        generation: slot.generation,
        commandUuid: randomUUID(),
        targetUuid: connected.row.uuid,
        request: { participantId: participant },
        deadline: new Date(Date.now() + 30000)
      });
      await a.capacity.claim({
        kind: "browser",
        callId: connected.row.uuid,
        operationId: bridgeId,
        generation: slot.generation,
        agentId: f.agentId
      });
    });
  } finally {
    db.release();
  }
  assert.match(
    await command(
      `originate {origination_uuid=${agentUuid},rtp_secure_media=false,absolute_codec_string=PCMU,outbound_dialer_call_id=${connected.row.uuid},ignore_early_media=true}sofia/internal-webrtc/sip:d04-agent@${phone.address} &park()`
    ),
    /^\+OK/
  );
  assert.equal((await call(connected.row.uuid)).agent_connected_at, null);
  assert.equal(
    (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0].state,
    "connecting"
  );
  const bridgeDriver = createCommandDriver({
    ...esl,
    buildCommand: () => `uuid_bridge ${connected.row.uuid} ${agentUuid}`,
    async verify(op, job, signal) {
      assert.match(job.body, /^\+OK/);
      await until(
        () => checked(async () => Boolean((await call(connected.row.uuid)).agent_connected_at)),
        "actual winner bridge",
        4000
      );
      if (signal.aborted) return null;
      return {
        state: "succeeded",
        result: { jobUuid: op.command_uuid },
        evidence: "fixture fixed job plus real customer/agent CHANNEL_BRIDGE"
      };
    },
    async reconcile() {
      return null;
    }
  });
  assert.equal((await limited.executor.run(bridgeId, "normal", bridgeDriver)).status, "terminal");
  const bridged = await call(connected.row.uuid);
  assert.equal(bridged.state, "agent_connected");
  assert.ok(bridged.agent_connected_at >= bridged.pstn_answered_at);
  await delay(400);
  connected.control.hangup();
  const connectedResult = await connected.result;
  const bridgedTone = assertTone(
    connectedResult.rtp.slice(-15).flatMap((p) => p.payload.map(decodeUlaw)),
    660
  );
  await until(
    async () => (await command(`uuid_exists ${agentUuid}`)) === "false",
    "native bridged agent cleanup"
  );
  await clean(connected.row.uuid);
  await recover();
  await pass("D04.2 waiting answer and later real authorized bridge use separate clocks", {
    uuid: connected.row.uuid,
    bridged,
    bridgedTone,
    e02Acceptance: "seeded fixture, no E02 API/browser acceptance claim"
  });
  const before = await call(connected.row.uuid);
  for (const event of ["CHANNEL_ANSWER", "CHANNEL_BRIDGE"]) {
    await adapter.persistFreeSwitchEvent(config, f.pool, {
      body: "",
      headers: {
        "event-name": event,
        "event-uuid": randomUUID(),
        "unique-id": connected.row.uuid,
        variable_outbound_dialer_ingress_uuid: connected.row.uuid,
        "other-leg-unique-id": agentUuid
      }
    });
  }
  assert.deepEqual(await call(connected.row.uuid), before);
  await pass("D04.3 late native answer/bridge replay cannot resurrect terminal call");
  await until(
    () =>
      checked(async () => {
        await recover();
        return JSON.parse(await ingressRequest(socket, "/status")).used === 0;
      }),
    "journal terminal ACKs"
  );
  report.snapshot = await f.snapshot();
  assert.equal(report.snapshot.call_capacity_reservations.filter((r) => r.state !== "released").length, 0);
  assert.equal(report.snapshot.call_operations.filter((r) => !r.resolved_at).length, 0);
  assert.equal(report.snapshot.agent_call_slots.filter((r) => r.state !== "free").length, 0);
  assert.equal(JSON.parse(await command("show channels as json")).row_count, 0);
  if (eventError) throw eventError;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
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
