import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { open, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEsl, invite } from "./a02-ingress-probe.mjs";
import { until } from "./a05-media.mjs";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { sendFreeSwitchApiCommand } from "../apps/api/dist-test/esl.js";
import { reconcileIngress } from "../apps/api/dist-test/inbound-ingress.js";
import { __testing as ingressMetrics } from "../apps/api/dist-test/metrics.js";
import { ingressRequest, readIngressRecords } from "../apps/api/dist-test/ingress-agent.js";
const directory = process.argv[2];
assert.match(directory ?? "", /^\/tmp\/outbound-d03\.[A-Za-z0-9]+$/);
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
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  boundary:
    "Real product entrypoint/Lua, independent journal process, product PostgreSQL evidence/calls; pre-queue D03, no provider/browser/production"
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
let agent, f, observer;
const log = await open(join(directory, "agent.log"), "a");
async function startAgent() {
  agent = fork(new URL("../apps/api/dist-test/ingress-agent.js", import.meta.url), [], {
    env: {
      FREESWITCH_INGRESS_ENABLED: "true",
      FREESWITCH_INGRESS_SOCKET: socket,
      FREESWITCH_INGRESS_JOURNAL_SLOTS: "2",
      FREESWITCH_ESL_PASSWORD: config.FREESWITCH_ESL_PASSWORD
    },
    stdio: ["ignore", log.fd, log.fd, "ipc"]
  });
  await writeFile(join(directory, "journal-agent.pid"), String(agent.pid));
  await until(
    async () => {
      try {
        return !!JSON.parse(await ingressRequest(socket, "/status"));
      } catch {
        return false;
      }
    },
    "journal process startup",
    10000
  );
}
async function stopAgent(signal = "SIGTERM") {
  if (!agent) return;
  const exited = once(agent, "exit");
  agent.kill(signal);
  await exited;
  agent = null;
  await rm(join(directory, "journal-agent.pid"), { force: true });
}
const recover = (checkpoint) => reconcileIngress(f.pool, socket, command, checkpoint);
async function crashImporter(failAt) {
  const child = fork(new URL("./d03-import-worker.mjs", import.meta.url), [], {
    env: {},
    stdio: ["ignore", log.fd, log.fd, "ipc"]
  });
  const received = once(child, "message");
  child.send({
    database: {
      host: join(directory, "socket"),
      database: "d03",
      user: "postgres",
      options: f.pool.options.options
    },
    socket,
    config,
    failAt
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const [message] = await received;
    assert.equal(message.point, failAt, JSON.stringify(message));
  } finally {
    clearTimeout(timer);
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
  }
}
const entries = () => readIngressRecords(socket);
const sip = async (spec = {}) => {
  const result = await invite({ ...spec, port: 5090 });
  assert.equal(result.final, 503);
  assert.equal(result.rtp.length, 0);
  const final = result.messages.find((m) => m.first.startsWith("SIP/2.0 503"));
  assert.ok(final.ms < 3000, JSON.stringify(result.messages));
  return { final: result.final, elapsedMs: final.ms };
};
try {
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
    "product FS startup",
    30000
  );
  report.fs = await command("version");
  f = await cleanupFixture(
    { host: join(directory, "socket"), database: "d03", user: "postgres", connectionTimeoutMillis: 2000 },
    {
      onPoolError: () => {
        report.databaseDisconnectObserved = true;
      }
    }
  );
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const queue = (await f.pool.query("select id from inbound_queues limit 1")).rows[0].id;
  await f.pool.query(
    "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values('+12025550100','D03',$1,true)",
    [queue]
  );
  assert.equal(await new InboundConfigurationPublisher(f.pool, config).reconcile(), "applied");
  // No daemon => bounded refusal, no durable receipt and no guaranteed history.
  await pass("D03.3 unavailable journal refuses before answer", await sip());
  await startAgent();
  const pending = sip();
  await until(async () => (await entries()).length === 1, "product Lua durable receipt", 5000);
  const captured = (await entries())[0];
  assert.equal(await command(`uuid_exists ${captured.uuid}`), "true");
  const duplicate = await fetch("http://127.0.0.1:18093/capture", {
    method: "POST",
    body: new URLSearchParams({ uuid: captured.uuid })
  });
  assert.equal(await duplicate.text(), `stored:${captured.uuid}`);
  assert.equal((await entries()).length, 1);
  await recover();
  assert.equal(
    (await f.pool.query("select state from calls where id=$1", [captured.uuid])).rows[0].state,
    "received"
  );
  await pass(
    "D03.1 duplicate native capture and live discovery without prior calls row; no queue admission",
    {
      uuid: captured.uuid,
      arrival: captured.arrivedUs
    }
  );
  await pending;
  // Lose the API/DB importer before first INSERT for the next ended call.
  await sip();
  const second = (await entries()).find((r) => r.uuid !== captured.uuid);
  assert.ok(second);
  await crashImporter("before-insert");
  // This error occurs on the first row; the second still has no PostgreSQL row.
  assert.equal(
    (await f.pool.query("select count(*)::int as n from calls where id=$1", [second.uuid])).rows[0].n,
    0
  );
  await crashImporter("after-commit");
  await stopAgent("SIGKILL");
  await startAgent();
  await recover();
  await recover();
  const calls = (
    await f.pool.query("select id,state,arrived_at,queue_deadline_at from calls order by arrived_at,id")
  ).rows;
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.state === "failed"));
  await pass(
    "D03.1/D03.2 before INSERT, lost commit ACK, journal SIGKILL/restart and repeated terminal import",
    { calls }
  );
  for (const table of ["call_offers", "call_operations", "call_capacity_reservations"])
    assert.equal((await f.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0);
  assert.equal(
    observer.events.filter((e) => ["CHANNEL_ANSWER", "CHANNEL_BRIDGE"].includes(e["event-name"])).length,
    0
  );
  assert.equal(
    observer.events.filter((e) => e["event-name"] === "CHANNEL_CREATE" && e["unique-id"] === captured.uuid)
      .length,
    1
  );
  await pass("D03.2 terminal history has zero offers, operations, originates or fallback", {
    nativeAnswersOrBridges: 0,
    nativeCreateForDuplicate: 1
  });
  // Two captured calls with no importer exhaust the two-slot test budget.
  await sip();
  await sip();
  const retained = await entries();
  assert.equal(retained.length, 2);
  const fullRefusal = await sip();
  const alarm = JSON.parse(await ingressRequest(socket, "/status"));
  assert.equal(alarm.used, alarm.capacity);
  assert.equal(alarm.unacknowledged, 2);
  assert.ok(alarm.failures > 0);
  await assert.rejects(
    recover(async (point) => {
      if (point === "before-insert") throw new Error("alarm checkpoint");
    }),
    /alarm checkpoint/
  );
  const exposed = await ingressMetrics.metrics();
  assert.match(exposed, /outbound_dialer_ingress_journal_used 2/);
  assert.match(exposed, /outbound_dialer_ingress_journal_capacity 2/);
  await pass("D03.3 full unacknowledged journal refuses without evicting evidence", {
    ...fullRefusal,
    alarm
  });
  assert.deepEqual(
    (await entries()).map((r) => r.uuid),
    retained.map((r) => r.uuid)
  );
  const lock = new DatabaseSync(join(directory, "ingress.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  try {
    await pass("D03.3 SQLite lock refuses within SIP deadline", await sip());
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  agent.kill("SIGSTOP");
  try {
    await pass("D03.3 suspended journal refuses within SIP deadline", await sip());
  } finally {
    agent.kill("SIGCONT");
  }
  await recover();
  // Stop PostgreSQL while a proven captured channel is still alive, then let
  // that caller end during the DB outage. No importer/API subscriber is needed.
  const prior = new Set((await entries()).map((r) => r.uuid));
  const dbOutageCall = sip();
  await until(async () => (await entries()).some((r) => !prior.has(r.uuid)), "capture before DB stop");
  const dbOutageId = (await entries()).find((r) => !prior.has(r.uuid)).uuid;
  assert.equal(await command(`uuid_exists ${dbOutageId}`), "true");
  execFileSync("docker", ["stop", process.env.D03_PG_CONTAINER], { stdio: "pipe", timeout: 15000 });
  await dbOutageCall;
  assert.equal(await command(`uuid_exists ${dbOutageId}`), "false");
  await assert.rejects(recover());
  // A second fresh, captured channel dies in an abrupt FS restart while DB is
  // still down. Its hook cannot run; retain capture and infer absence only after
  // a new authenticated FS connection is available.
  const beforeFs = new Set((await entries()).map((r) => r.uuid));
  const fsOutageCall = invite({ port: 5090, allowNoFinal: true, timeoutMs: 3500 });
  await until(async () => (await entries()).some((r) => !beforeFs.has(r.uuid)), "capture before FS kill");
  const fsOutageId = (await entries()).find((r) => !beforeFs.has(r.uuid)).uuid;
  assert.equal(await command(`uuid_exists ${fsOutageId}`), "true");
  const before = (await entries()).map((r) => r.uuid);
  execFileSync("docker", ["kill", process.env.D03_FS_CONTAINER], { stdio: "pipe", timeout: 15000 });
  await stopAgent("SIGKILL");
  await startAgent();
  assert.deepEqual(
    (await entries()).map((r) => r.uuid),
    before
  );
  const interrupted = await fsOutageCall;
  assert.equal(interrupted.rtp.length, 0);
  assert.ok(!interrupted.final || interrupted.final >= 300);
  report.outageCalls = { dbOutageId, fsOutageId, dbStoppedWhileLive: true, fsKilledWhileLive: true };
  execFileSync("docker", ["start", process.env.D03_PG_CONTAINER], { stdio: "pipe", timeout: 15000 });
  execFileSync("docker", ["start", process.env.D03_FS_CONTAINER], { stdio: "pipe", timeout: 15000 });
  await until(
    async () => {
      try {
        return /internal-webrtc.*RUNNING/.test(await command("sofia status"));
      } catch {
        return false;
      }
    },
    "FS restart",
    30000
  );
  await until(
    async () => {
      try {
        await recover();
        return true;
      } catch {
        return false;
      }
    },
    "PG recovery",
    15000
  );
  await pass("D03.2/D03.3 DB outage and FS SIGKILL with journal restart preserve terminal-only history");
  const status = JSON.parse(await ingressRequest(socket, "/status"));
  assert.equal(status.unacknowledged, 0);
  assert.equal(status.used, 0);
  assert.equal(
    (await f.pool.query("select count(*)::int as n from calls where ended_at is null")).rows[0].n,
    0
  );
  report.finalStatus = status;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  try {
    await stopAgent();
    observer?.close();
    if (f) report.cleanup = await f.cleanup();
  } finally {
    await log.close();
    await save();
  }
}
