// C06 integrated cleanup lab: actual FS jobs/events + product PostgreSQL schema.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { render as renderBase } from "./a05-rebridge-probe.mjs";
import { openEsl } from "./a02-ingress-probe.mjs";
import { endpoint, until, assertTone } from "./a05-media.mjs";
import { uniqueEndpoint } from "./a04-binding.mjs";
import { relay } from "./a05-executor.mjs";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import { cleanupHttp, cleanupRecording } from "../tests/fixtures/inbound/cleanup-http.mjs";
import { nativeCallControlExecutor } from "../apps/api/dist-test/native-call-control.js";
import { CallExecutor } from "../apps/api/dist-test/call-executor.js";
import { createCommandDriver } from "../apps/api/dist-test/call-command-transport.js";
import { reconcileCoordinatedCallCleanup } from "../apps/api/dist-test/call-cleanup.js";
import { __testing as events } from "../apps/api/dist-test/esl-events.js";
const [mode, directory] = process.argv.slice(2);
assert.match(directory ?? "", /^\/tmp\/outbound-c06\.[A-Za-z0-9]+$/);
async function render(identities = []) {
  await renderBase(directory, identities);
  const vm = (
    await readFile(
      new URL("../infra/freeswitch/templates/dialplan/default/voicemail-drop.xml.tpl", import.meta.url),
      "utf8"
    )
  )
    .replace("<include>", "")
    .replace("</include>", "");
  const xml = await readFile(join(directory, "freeswitch.xml"), "utf8");
  await writeFile(
    join(directory, "freeswitch.xml"),
    xml.replace(
      '</section>\n  <section name="directory">',
      `<context name="default">${vm}</context></section>\n  <section name="directory">`
    )
  );
}
if (mode === "render") {
  await render();
  process.exit(0);
}
assert.equal(mode, "probe");
const config = {
  host: join(directory, "socket"),
  database: "c06",
  user: "postgres",
  max: 8,
  connectionTimeoutMillis: 1000
};
const admin = new pg.Pool(config);
let observer, f, executor, transport;
const clients = [];
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  media:
    "isolated UDP SIP/PCMU RTP; product HTTP routes, C03/C06 native controls and event adapter; test-only admission/verified Desk; no browser/provider"
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
let chain = Promise.resolve();
async function command(text) {
  const next = chain.then(() => observer.command(`api ${text}`));
  chain = next.catch(() => {});
  const body = (await next).body.trim();
  report.commands.push({ text, body });
  return body;
}
async function pass(name, evidence) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
async function ingest(s, uuid) {
  const terminal = await until(
    () =>
      observer.events.find((e) => e["unique-id"] === uuid && e["event-name"] === "CHANNEL_HANGUP_COMPLETE"),
    "exact terminal event"
  );
  const headers = { ...terminal, variable_outbound_dialer_call_id: s.callId };
  await events.persistFreeSwitchEvent({}, f.pool, { headers, body: "" });
  await events.persistFreeSwitchEvent({}, f.pool, { headers, body: "" });
}
async function kill(s, uuid) {
  if ((await command(`uuid_exists ${uuid}`)) === "true")
    assert.match(await command(`uuid_kill ${uuid} NORMAL_CLEARING`), /^\+OK/);
  await ingest(s, uuid);
}
async function start(s, uuid, destination) {
  assert.match(
    await command(
      `originate {origination_uuid=${uuid},outbound_dialer_call_id=${s.callId},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${destination} &park()`
    ),
    /^\+OK/
  );
  await until(
    () => observer.events.find((e) => e["event-name"] === "CHANNEL_ANSWER" && e["unique-id"] === uuid),
    "actual SIP answer"
  );
}
async function receiveTone(client, frequency) {
  const start = client.received.length;
  await until(() => client.received.length >= start + 4000, "decoded RTP");
  return assertTone(client.received.slice(start + 800, start + 4000), frequency);
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
  await observer.command(
    "event plain BACKGROUND_JOB CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_EXECUTE CHANNEL_EXECUTE_COMPLETE CHANNEL_STATE CHANNEL_HANGUP_COMPLETE CHANNEL_DESTROY CUSTOM outbound_dialer::voicemail_playback_started outbound_dialer::voicemail_playback_completed outbound_dialer::voicemail_playback_failed"
  );
  await command("console loglevel debug");
  await observer.command("log debug");
  report.fs = await command("version");
  report.database = (await admin.query("select version()")).rows[0].version;
  const identities = ["desk_agent", "desk_customer"].map((username) => ({
    username,
    password: randomBytes(24).toString("hex")
  }));
  await render(identities);
  assert.match(await command("reloadxml"), /\+OK/);
  for (const [i, identity] of identities.entries()) {
    const client = await endpoint({ ...identity, source: `127.0.0.${3 + i}`, frequency: i ? 440 : 880 });
    clients.push(client);
    await client.register();
  }
  const destinations = [];
  for (const identity of identities)
    destinations.push(
      await until(
        async () =>
          uniqueEndpoint(
            await command(`sofia_contact a04-loopback/${identity.username}@a04.invalid`),
            identity.username
          ),
        "verified endpoint"
      )
    );
  // Real delayed bytes and lost ACK; false uuid_exists must retain the claim.
  f = await cleanupFixture(config);
  await admin.query(
    `create role c06_executor login connection limit 8;grant usage on schema ${f.schema} to c06_executor;grant all on all tables in schema ${f.schema} to c06_executor;grant usage,select on all sequences in schema ${f.schema} to c06_executor`
  );
  executor = await CallExecutor.create(
    { ...config, user: "c06_executor", options: `-c search_path=${f.schema}` },
    0
  );
  const delayed = await f.seed({ unresolved: true });
  transport = await relay();
  const driver = createCommandDriver({
    host: "127.0.0.1",
    port: transport.port,
    password: "a02-disposable-only",
    buildCommand: () =>
      `originate {origination_uuid=${delayed.agentUuid},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${destinations[0]} &park()`,
    verify: async () => null,
    reconcile: async () => null
  });
  const execution = executor.run(delayed.operationId, "normal", driver);
  await until(() => transport.queued, "physical command held");
  assert.equal(await command(`uuid_exists ${delayed.agentUuid}`), "false");
  assert.equal((await reconcileCoordinatedCallCleanup(f.pool, delayed.callId)).uncertain, true);
  assert.equal((await f.snapshot()).agent_call_slots[0].state, "uncertain");
  transport.forward();
  await until(
    () =>
      observer.events.find(
        (e) => e["event-name"] === "CHANNEL_CREATE" && e["unique-id"] === delayed.agentUuid
      ),
    "delayed leg created"
  );
  const operation = (await f.pool.query("select * from call_operations where id=$1", [delayed.operationId]))
    .rows[0];
  const job = await until(
    () =>
      observer.events.find(
        (e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === operation.command_uuid
      ),
    "exact job completed"
  );
  assert.equal((await execution).status, "uncertain");
  await transport.close();
  transport = null;
  assert.equal((await reconcileCoordinatedCallCleanup(f.pool, delayed.callId)).uncertain, true);
  const reconciliation = await executor.run(delayed.operationId, "normal", {
    send: async () => {
      throw new Error("duplicate send");
    },
    reconcile: async () => ({
      state: "succeeded",
      result: { job: operation.command_uuid },
      evidence: `closed relay/sender; exact BACKGROUND_JOB ${job["job-uuid"]}; live fixed UUID`
    })
  });
  assert.equal(reconciliation.status, "terminal");
  assert.equal(
    (await reconcileCoordinatedCallCleanup(f.pool, delayed.callId)).slots,
    0,
    "resolved job does not prove leg cleanup"
  );
  await start(delayed, delayed.customerUuid, destinations[1]);
  await kill(delayed, delayed.agentUuid);
  await kill(delayed, delayed.customerUuid);
  assert.equal((await f.snapshot()).agent_call_slots[0].state, "free");
  assert.ok((await f.snapshot()).call_capacity_reservations.every((r) => r.state === "released"));
  await pass("C06.1 delayed originate, false probe, lost ACK, quiesced job and exact once cleanup", {
    snapshot: await f.snapshot()
  });
  await executor.close();
  executor = null;
  await f.cleanup();
  f = null;
  await admin.query("drop role c06_executor");
  // Prerecorded fixture: actual repo-owned voicemail dialplan and decoded PCMU.
  const wav = Buffer.alloc(44 + 8000 * 2 * 6);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let n = 0; n < 48000; n++)
    wav.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 660 * n) / 8000)), 44 + 2 * n);
  await writeFile(join(directory, "voicemail.wav"), wav);
  for (const completedFirst of [true, false]) {
    f = await cleanupFixture(config);
    const s = await f.seed({ vm: true });
    await start(s, s.agentUuid, destinations[0]);
    await start(s, s.customerUuid, destinations[1]);
    assert.match(await command(`uuid_bridge ${s.customerUuid} ${s.agentUuid}`), /^\+OK/);
    await until(
      () =>
        observer.events.find(
          (e) => e["event-name"] === "CHANNEL_BRIDGE" && e["unique-id"] === s.customerUuid
        ),
      "actual bridge"
    );
    const beforeMedia = [await receiveTone(clients[0], 440), await receiveTone(clients[1], 880)];
    await command(`uuid_setvar ${s.customerUuid} voicemail_drop_call_id ${s.callId}`);
    await command(`uuid_setvar ${s.customerUuid} voicemail_drop_file /a02/voicemail.wav`);
    assert.match(await command(`uuid_transfer ${s.customerUuid} voicemail_drop XML default`), /^\+OK/);
    await until(
      () =>
        observer.events.find(
          (e) =>
            e["event-subclass"] === "outbound_dialer::voicemail_playback_started" &&
            e["outbound-dialer-call-id"] === s.callId
        ),
      "playback start"
    );
    await kill(s, s.agentUuid);
    assert.equal((await f.snapshot()).calls[0].state, "agent_released");
    assert.equal(await command(`uuid_exists ${s.customerUuid}`), "true");
    const audio = await receiveTone(clients[1], 660);
    const next = await f.seed();
    await start(next, next.agentUuid, destinations[0]);
    await start(next, next.customerUuid, destinations[1]);
    await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
    const newSlot = (await f.snapshot()).agent_call_slots[0];
    const complete = await until(
      () =>
        observer.events.find(
          (e) =>
            e["event-subclass"] === "outbound_dialer::voicemail_playback_completed" &&
            e["outbound-dialer-call-id"] === s.callId
        ),
      "playback completed",
      10000
    );
    const deliver = () => events.persistFreeSwitchEvent({}, f.pool, { headers: complete, body: "" });
    if (completedFirst) {
      await deliver();
      await ingest(s, s.customerUuid);
    } else {
      await ingest(s, s.customerUuid);
      await deliver();
    }
    await ingest(s, s.agentUuid);
    assert.deepEqual((await f.snapshot()).agent_call_slots[0], newSlot);
    assert.equal((await f.snapshot()).agents[0].availability_status, "paused");
    assert.ok(
      (await f.snapshot()).call_capacity_reservations
        .filter((r) => r.call_id === s.callId)
        .every((r) => r.state === "released")
    );
    await pass(`C06.2 VM release/new call/pause, completed-first=${completedFirst}`, {
      beforeMedia,
      audio,
      oldCall: s.callId,
      newCall: next.callId,
      snapshot: await f.snapshot()
    });
    await kill(next, next.agentUuid);
    await kill(next, next.customerUuid);
    await f.cleanup();
    f = null;
    assert.match(await command("show channels count"), /^0 total/);
  }
  const longWav = Buffer.alloc(44 + 8000 * 2 * 12);
  wav.copy(longWav, 0, 0, 44);
  longWav.writeUInt32LE(longWav.length - 8, 4);
  longWav.writeUInt32LE(longWav.length - 44, 40);
  for (let n = 0; n < 96000; n++)
    longWav.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 660 * n) / 8000)), 44 + 2 * n);
  await writeFile(join(directory, "voicemail-long.wav"), longWav);
  // Complete real control path: authenticated HTTP -> persisted C03 chain ->
  // one physical send per fixed job -> genuine ESL frames -> fenced cleanup.
  for (const scenario of ["end", "vm-completed-first", "vm-hangup-first", "vm-lost-response"]) {
    f = await cleanupFixture(config);
    await admin.query(
      `create role c06_executor login connection limit 8;grant usage on schema ${f.schema} to c06_executor;grant all on all tables in schema ${f.schema} to c06_executor;grant usage,select on all sequences in schema ${f.schema} to c06_executor`
    );
    executor = await CallExecutor.create(
      { ...config, user: "c06_executor", options: `-c search_path=${f.schema}` },
      0
    );
    const s = await f.seed();
    await cleanupRecording(
      f,
      scenario === "vm-lost-response" ? "/a02/voicemail-long.wav" : "/a02/voicemail.wav"
    );
    let cursor = observer.eventFrames.length,
      pumping = false,
      pumpFailure;
    const held = [];
    let holdCustomerEnd = scenario !== "end";
    const pump = async () => {
      if (pumping || pumpFailure) return;
      pumping = true;
      try {
        while (cursor < observer.eventFrames.length) {
          const frame = observer.eventFrames[cursor++],
            h = frame.headers;
          if (
            holdCustomerEnd &&
            ((h["unique-id"] === s.customerUuid &&
              ["CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"].includes(h["event-name"])) ||
              (h["outbound-dialer-call-id"] === s.callId &&
                h["event-subclass"] === "outbound_dialer::voicemail_playback_completed"))
          )
            held.push(frame);
          else if (
            h["variable_outbound_dialer_call_id"] ||
            h["outbound-dialer-call-id"] ||
            h["event-name"] === "BACKGROUND_JOB"
          )
            await events.persistFreeSwitchEvent({}, f.pool, frame);
        }
      } catch (e) {
        pumpFailure = e;
      } finally {
        pumping = false;
      }
    };
    const timer = setInterval(() => void pump(), 10);
    let http;
    try {
      await start(s, s.agentUuid, destinations[0]);
      await start(s, s.customerUuid, destinations[1]);
      assert.match(await command(`uuid_bridge ${s.customerUuid} ${s.agentUuid}`), /^\+OK/);
      const beforeMedia = [await receiveTone(clients[0], 440), await receiveTone(clients[1], 880)];
      if (scenario === "vm-lost-response") transport = await relay();
      const adapter = nativeCallControlExecutor(f.pool, executor, {
        host: "127.0.0.1",
        port: transport?.port ?? 8021,
        password: "a02-disposable-only"
      });
      http = await cleanupHttp(f, { wake: adapter.wakeExecutor });
      const action = scenario === "end" ? "end" : "drop-voicemail",
        body = { intent: http.intent() };
      const responsePromise = http.api(s.callId, action, body);
      let unresolvedSnapshot;
      if (transport) {
        await until(() => transport.queued, "native transfer bytes held");
        const replay = await http.api(s.callId, action, body);
        assert.equal(replay.statusCode, 200, replay.body);
        assert.equal(http.wakes.length, 1);
        unresolvedSnapshot = await f.snapshot();
        assert.equal(unresolvedSnapshot.call_operations.filter((o) => !o.resolved_at).length, 2);
        assert.equal(unresolvedSnapshot.agent_call_slots[0].state, "releasing");
        transport.forward();
        await until(
          () =>
            observer.events.find(
              (e) =>
                e["outbound-dialer-call-id"] === s.callId &&
                e["event-subclass"] === "outbound_dialer::voicemail_playback_started"
            ),
          "actual native transfer with lost reply"
        );
      }
      const response = await responsePromise;
      assert.equal(response.statusCode, 200, response.body);
      if (transport) {
        assert.equal(transport.sends.length, 1);
        await transport.close();
        transport = null;
        // New adapter/worker resumes from the listener's exact fixed-job evidence;
        // it must not resend the transfer after the old relay/socket has closed.
        const replacement = nativeCallControlExecutor(f.pool, executor, {
          host: "127.0.0.1",
          port: 8021,
          password: "a02-disposable-only"
        });
        await replacement.wakeExecutor(response.json().operationId);
      }
      await until(
        async () => {
          if (pumpFailure) throw pumpFailure;
          await pump();
          const snapshot = await f.snapshot();
          if (snapshot.call_operations.some((o) => !o.resolved_at))
            await nativeCallControlExecutor(f.pool, executor, {
              host: "127.0.0.1",
              port: 8021,
              password: "a02-disposable-only"
            }).wakeExecutor(response.json().operationId);
          return (await f.snapshot()).agent_call_slots[0].state === "free";
        },
        "HTTP native control releases only verified old slot",
        10000
      );
      const afterRelease = await f.snapshot();
      const operationJobs = afterRelease.call_operations.filter(
        (o) => o.request.rootOperationId === response.json().operationId
      );
      assert.equal(operationJobs.length, 2);
      for (const op of operationJobs)
        assert.equal(
          observer.events.filter(
            (e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === op.command_uuid
          ).length,
          1,
          "exactly one physical job for each operation"
        );
      assert.deepEqual((await http.api(s.callId, action, body)).json(), response.json());
      assert.equal(http.wakes.length, 1);
      if (scenario === "end") {
        assert.ok(afterRelease.calls[0].ended_at);
        assert.equal(afterRelease.calls[0].outcome, "answered");
        assert.ok(afterRelease.call_capacity_reservations.every((r) => r.state === "released"));
      } else {
        assert.equal(afterRelease.calls[0].state, "agent_released");
        assert.equal(await command(`uuid_exists ${s.customerUuid}`), "true");
        const audio = await receiveTone(clients[1], 660);
        const next = await f.seed();
        await start(next, next.agentUuid, destinations[0]);
        await start(next, next.customerUuid, destinations[1]);
        await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
        const newSlot = (await f.snapshot()).agent_call_slots[0];
        await until(
          () =>
            held.some(
              (frame) => frame.headers["event-subclass"] === "outbound_dialer::voicemail_playback_completed"
            ) && held.some((frame) => frame.headers["event-name"] === "CHANNEL_HANGUP_COMPLETE"),
          "hold both real customer terminal deliveries",
          10000
        );
        holdCustomerEnd = false;
        const complete = held.find(
          (frame) => frame.headers["event-subclass"] === "outbound_dialer::voicemail_playback_completed"
        );
        const end = held.filter((frame) =>
          ["CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"].includes(frame.headers["event-name"])
        );
        const ordered = scenario === "vm-hangup-first" ? [...end, complete] : [complete, ...end];
        for (const frame of [...ordered, ...ordered]) await events.persistFreeSwitchEvent({}, f.pool, frame);
        assert.deepEqual((await f.snapshot()).agent_call_slots[0], newSlot);
        assert.equal((await f.snapshot()).agents[0].availability_status, "paused");
        assert.deepEqual((await http.api(s.callId, action, body)).json(), response.json());
        assert.equal(http.wakes.length, 1);
        assert.ok(
          (await f.snapshot()).call_capacity_reservations
            .filter((r) => r.call_id === s.callId)
            .every((r) => r.state === "released")
        );
        report.scenarios.push({
          name: `native ${scenario} media`,
          status: "passed",
          audio,
          newCall: next.callId
        });
        for (const leg of [next.agentUuid, next.customerUuid])
          if ((await command(`uuid_exists ${leg}`)) === "true")
            await command(`uuid_kill ${leg} NORMAL_CLEARING`);
        await until(async () => {
          if (pumpFailure) throw pumpFailure;
          return (await f.snapshot()).agent_call_slots[0].state === "free";
        }, "event pump cleans new call");
      }
      await pass(`C06 native HTTP/C03/FS ${scenario}`, {
        beforeMedia,
        response: response.json(),
        unresolvedSnapshot,
        snapshot: await f.snapshot()
      });
    } finally {
      clearInterval(timer);
      await until(() => !pumping, "native event pump stopped");
      await http?.close();
      await transport?.close();
      transport = null;
      await executor.close();
      executor = null;
      await f.cleanup();
      f = null;
      await admin.query("drop role c06_executor");
    }
    assert.match(await command("show channels count"), /^0 total/);
  }
  report.status = "passed";
  await save();
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  await save();
  throw error;
} finally {
  await transport?.close();
  await executor?.close();
  if (observer) {
    await command("hupall NORMAL_CLEARING");
    await writeFile(join(directory, "events.json"), JSON.stringify(observer.events, null, 2));
    await writeFile(join(directory, "fs-debug.log"), observer.logs.join("\n"));
  }
  for (const c of clients) c.close();
  observer?.close();
  await f?.cleanup();
  await admin.query("drop role if exists c06_executor");
  await admin.end();
}
