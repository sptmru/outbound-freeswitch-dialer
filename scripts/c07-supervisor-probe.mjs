// C07: disposable product PostgreSQL + actual FreeSWITCH SIP/RTP and C03 sender.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { render as baseRender } from "./a05-rebridge-probe.mjs";
import { openEsl } from "./a02-ingress-probe.mjs";
import { endpoint, until, assertTone, power } from "./a05-media.mjs";
import { supervisorFixture, limitedExecutor, supervisorHttp } from "../tests/fixtures/inbound/supervisor.mjs";
import {
  supervisorExecutor,
  persistCoordinatedSupervisorEvent
} from "../apps/api/dist-test/supervisor-coordination.js";
import { __testing as eventAdapter } from "../apps/api/dist-test/esl-events.js";
import { withCallAdmission } from "../apps/api/dist-test/call-admission.js";
import { defaultCapacityLimits } from "../apps/api/dist-test/call-capacity.js";
const [mode, directory] = process.argv.slice(2);
assert.match(directory ?? "", /^\/tmp\/outbound-c07\.[A-Za-z0-9]+$/);
async function render(identities = []) {
  await baseRender(directory, identities);
  await writeFile(
    join(directory, "freeswitch.xml"),
    (await readFile(join(directory, "freeswitch.xml"), "utf8")).replaceAll("a04-loopback", "internal-webrtc")
  );
}
if (mode === "render") {
  await render();
  process.exit(0);
}
assert.equal(mode, "probe");
const pgConfig = {
  host: join(directory, "socket"),
  database: "c07",
  user: "postgres",
  max: 8,
  connectionTimeoutMillis: 1000
};
const config = {
  FREESWITCH_ESL_ENABLED: true,
  FREESWITCH_ESL_HOST: "127.0.0.1",
  FREESWITCH_ESL_PORT: 8021,
  FREESWITCH_ESL_PASSWORD: "a02-disposable-only",
  FREESWITCH_DOMAIN: "a04.invalid"
};
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  media:
    "actual isolated UDP SIP/PCMU RTP; product HTTP/C03/event adapter; test-only reconciled admission and Desk; no browser/provider/production"
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
let observer,
  f,
  ex,
  http,
  otherHttp,
  timer,
  ingestion = Promise.resolve(),
  cursor = 0;
const clients = [];
let resumeSupervisorSend = () => {};
let commands = Promise.resolve();
async function command(text) {
  const next = commands.then(() => observer.command(`api ${text}`));
  commands = next.catch(() => {});
  const body = (await next).body.trim();
  report.commands.push({ text, body });
  return body;
}
async function pass(name, evidence = {}) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
async function tones(client, frequencies, absent = []) {
  const offset = client.received.length;
  await until(() => client.received.length >= offset + 4800, "decoded RTP");
  const samples = client.received.slice(offset + 1600, offset + 4800),
    found = frequencies.map((freq) => assertTone(samples, freq));
  for (const freq of absent)
    assert.ok(power(samples, freq) < 100, `unexpected ${freq} Hz: ${power(samples, freq)}`);
  return { found, absent: absent.map((frequency) => ({ frequency, level: power(samples, frequency) })) };
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
    "event plain BACKGROUND_JOB CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP CHANNEL_HANGUP_COMPLETE CHANNEL_DESTROY"
  );
  report.fs = await command("version");
  f = await supervisorFixture(pgConfig);
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const actor = await f.actor(),
    other = await f.actor(),
    s = await f.seed();
  const identities = ["desk_agent", "desk_customer", actor.username, other.username].map((username) => ({
    username,
    password: randomBytes(24).toString("hex")
  }));
  await render(identities);
  assert.match(await command("reloadxml"), /\+OK/);
  for (const [i, identity] of identities.entries()) {
    const client = await endpoint({
      ...identity,
      source: `127.0.0.${2 + i}`,
      frequency: [880, 440, 660, 990][i]
    });
    clients.push(client);
    await client.register();
  }
  const destinations = [];
  for (const identity of identities)
    destinations.push(
      await until(async () => {
        const r = await command(`sofia_contact internal-webrtc/${identity.username}@a04.invalid`);
        return r.startsWith("sofia/internal-webrtc/") ? r : false;
      }, "verified exact endpoint")
    );
  for (const [uuid, destination] of [
    [s.agentUuid, destinations[0]],
    [s.customerUuid, destinations[1]]
  ])
    assert.match(
      await command(
        `originate {origination_uuid=${uuid},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${destination} &park()`
      ),
      /^\+OK/
    );
  assert.match(await command(`uuid_bridge ${s.agentUuid} ${s.customerUuid}`), /^\+OK/);
  await pass("target call established with real SIP and bidirectional RTP", {
    agent: await tones(clients[0], [440]),
    customer: await tones(clients[1], [880])
  });
  const db = await f.pool.connect();
  try {
    await withCallAdmission(db, { callIds: [s.callId] }, (a) =>
      a.capacity.configure({ ...defaultCapacityLimits, supervisor: 1 })
    );
  } finally {
    db.release();
  }
  ex = await limitedExecutor(f, pgConfig);
  const adapter = supervisorExecutor(
    f.pool,
    ex.executor,
    config,
    { host: "127.0.0.1", port: 8021, password: config.FREESWITCH_ESL_PASSWORD },
    async (text, signal) => {
      if (signal.aborted) throw new Error("aborted");
      return command(text);
    }
  );
  timer = setInterval(() => {
    ingestion = ingestion.then(async () => {
      while (cursor < observer.eventFrames.length) {
        const frame = observer.eventFrames[cursor++];
        if (
          frame.headers.variable_outbound_dialer_supervisor_session_id ||
          frame.headers["event-name"] === "BACKGROUND_JOB"
        )
          await eventAdapter.persistFreeSwitchEvent(config, f.pool, frame);
      }
    });
    ingestion.catch(() => {});
  }, 10);
  let holdSend = true,
    admitted = false;
  const sendBarrier = new Promise((resolve) => {
    resumeSupervisorSend = resolve;
  });
  http = await supervisorHttp(f, actor, {
    config,
    adapter: {
      async wakeExecutor(id) {
        if (holdSend) {
          admitted = true;
          await sendBarrier;
        }
        return adapter.wakeExecutor(id);
      }
    }
  });
  otherHttp = await supervisorHttp(f, other, { config, adapter });
  const key = randomUUID();
  const deskCall = (
    await f.pool.query(
      "insert into calls(campaign_id,destination_number,normalized_destination_number) values($1,'+14155550100','+14155550100') returning id",
      [f.campaignId]
    )
  ).rows[0].id;
  const startsPromise = Promise.all([
    http.api("start", s.callId, { key }),
    http.api("start", s.callId, { key })
  ]);
  await until(() => admitted, "HTTP start committed before C03 physical send");
  const competingDesk = await f.pool.connect();
  try {
    await assert.rejects(
      withCallAdmission(
        competingDesk,
        { agentIds: [actor.agentId], campaignIds: [f.campaignId], callIds: [deskCall], startsCall: true },
        (a) =>
          a.reserve(
            {
              agentId: actor.agentId,
              userId: actor.userId,
              campaignId: f.campaignId,
              deskSessionId: actor.deskSessionId,
              expectedRevision: "1",
              bindingGeneration: "1"
            },
            deskCall
          )
      ),
      /supervisor_session/
    );
  } finally {
    competingDesk.release();
  }
  assert.equal(
    clients[2].invites.length,
    0,
    "occupied endpoint excludes concurrent Desk before first supervisor INVITE"
  );
  holdSend = false;
  resumeSupervisorSend();
  const starts = await startsPromise;
  starts.forEach((r) => assert.equal(r.statusCode, 201, r.body));
  assert.equal(starts[0].json().id, starts[1].json().id);
  const id = starts[0].json().id;
  const session = async () =>
    (await f.pool.query("select * from call_supervisor_sessions where id=$1", [id])).rows[0];
  await until(async () => (await session()).state === "active", "supervisor active", 7000);
  const first = await session();
  assert.equal(clients[2].invites.length, 1, "concurrent duplicate starts send one INVITE");
  assert.equal(
    (await http.api("start", s.callId)).statusCode,
    409,
    "distinct start identity cannot alias an existing operation"
  );
  const capacityDenied = await otherHttp.api("start", s.callId);
  assert.equal(capacityDenied.statusCode, 409, capacityDenied.body);
  assert.equal(clients[3].invites.length, 0);
  await assert.rejects(
    (async () => {
      const client = await f.pool.connect();
      try {
        await withCallAdmission(
          client,
          { agentIds: [actor.agentId], campaignIds: [f.campaignId] },
          async (a) => {
            const decision = await a.eligibility({
              agentId: actor.agentId,
              userId: actor.userId,
              campaignId: f.campaignId,
              deskSessionId: actor.deskSessionId,
              expectedRevision: "1",
              bindingGeneration: "1"
            });
            if (!decision.eligible) throw new Error(decision.reason);
          }
        );
      } finally {
        client.release();
      }
    })(),
    /supervisor_session/
  );
  await pass("concurrent starts, Desk exclusion and counted supervisor capacity", {
    physicalInvites: clients[2].invites.length,
    concurrentDeskRefusedBeforeFirstInvite: true,
    denied: capacityDenied.json(),
    listen: await tones(clients[2], [440, 880]),
    agentNoSupervisor: await tones(clients[0], [440], [660]),
    customerNoSupervisor: await tones(clients[1], [880], [660])
  });
  for (const nextMode of ["whisper", "join"]) {
    const old = await session();
    const result = await http.api("mode", id, { mode: nextMode });
    assert.equal(result.statusCode, 200, result.body);
    await until(
      async () => {
        const s = await session();
        return s.state === "active" && s.mode === nextMode;
      },
      `mode ${nextMode}`,
      7000
    );
    const current = await session();
    assert.notEqual(current.supervisor_leg_uuid, old.supervisor_leg_uuid);
    assert.equal(await command(`uuid_exists ${old.supervisor_leg_uuid}`), "false");
    assert.equal(await command(`uuid_exists ${current.supervisor_leg_uuid}`), "true");
    const oldEnd = observer.events.findIndex(
      (e) => e["unique-id"] === old.supervisor_leg_uuid && e["event-name"] === "CHANNEL_HANGUP_COMPLETE"
    );
    const newCreate = observer.events.findIndex(
      (e) => e["unique-id"] === current.supervisor_leg_uuid && e["event-name"] === "CHANNEL_CREATE"
    );
    assert.ok(oldEnd >= 0 && newCreate > oldEnd, "old leg terminal before replacement channel is created");
    for (const eventName of ["CHANNEL_ANSWER", "CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"])
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: id,
        supervisorLegUuid: old.supervisor_leg_uuid,
        eventName
      });
    assert.equal((await session()).state, "active");
    assert.equal((await session()).supervisor_leg_uuid, current.supervisor_leg_uuid);
    const cap = (
      await f.pool.query(
        "select * from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
        [id]
      )
    ).rows;
    assert.equal(cap.length, 1);
    await pass(`safe ${nextMode} replacement and obsolete leg fencing`, {
      generation: current.generation,
      oldEnd,
      newCreate,
      capacity: cap,
      supervisor: await tones(clients[2], [440, 880]),
      agent: await tones(clients[0], [440, 660]),
      customer: await tones(
        clients[1],
        nextMode === "join" ? [880, 660] : [880],
        nextMode === "whisper" ? [660] : []
      )
    });
  }
  assert.equal((await http.api("start", s.callId, { key })).json().id, id);
  assert.equal(clients[2].invites.length, 3);
  const stopKey = randomUUID();
  assert.equal((await http.api("stop", id, { key: stopKey })).statusCode, 204);
  assert.equal((await http.api("stop", id, { key: stopKey })).statusCode, 204);
  assert.equal((await session()).state, "ended");
  assert.equal(
    (
      await f.pool.query(
        "select count(*)::int n from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
        [id]
      )
    ).rows[0].n,
    0
  );
  assert.equal(await command(`uuid_exists ${first.target_agent_leg_uuid}`), "true");
  assert.equal(await command(`uuid_exists ${first.target_customer_leg_uuid}`), "true");
  await pass("idempotent stop releases only supervisor occupancy and capacity", {
    targetAgent: await tones(clients[0], [440], [660]),
    targetCustomer: await tones(clients[1], [880], [660])
  });
  // Reverse incompatibility with an already occupied pre-SIP Desk slot, verified before any INVITE.
  const deskDb = await f.pool.connect();
  try {
    await withCallAdmission(
      deskDb,
      { agentIds: [actor.agentId], campaignIds: [f.campaignId], callIds: [deskCall] },
      (a) =>
        a.reserve(
          {
            agentId: actor.agentId,
            userId: actor.userId,
            campaignId: f.campaignId,
            deskSessionId: actor.deskSessionId,
            expectedRevision: "1",
            bindingGeneration: "1"
          },
          deskCall
        )
    );
  } finally {
    deskDb.release();
  }
  const occupied = await http.api("start", s.callId);
  assert.equal(occupied.statusCode, 409, occupied.body);
  assert.equal(clients[2].invites.length, 3);
  await pass("occupied Desk blocks supervisor before SIP", { status: occupied.statusCode });
  report.sessions = (await f.pool.query("select * from call_supervisor_sessions")).rows;
  report.legs = (await f.pool.query("select * from supervisor_leg_evidence")).rows;
  report.operations = (
    await f.pool.query(
      "select id,state,command_uuid,target_uuid,command_kind,resolution_evidence from call_operations where request ? 'supervisorSessionId'"
    )
  ).rows;
  for (const uuid of [s.agentUuid, s.customerUuid]) await command(`uuid_kill ${uuid} NORMAL_CLEARING`);
  await until(async () => /0 total/.test(await command("show channels count")), "zero channels");
  await pass("no channels left after lab cleanup");
} catch (error) {
  report.failure = error.stack;
  await save();
  throw error;
} finally {
  resumeSupervisorSend();
  clearInterval(timer);
  await ingestion.catch(() => {});
  await http?.close();
  await otherHttp?.close();
  for (const c of clients) c.close();
  observer?.close();
  await ex?.close();
  await f?.cleanup();
  await save();
}
