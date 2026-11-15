import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { render } from "./a05-rebridge-probe.mjs";
import { relay } from "./a05-executor.mjs";
import { openEsl } from "./a02-ingress-probe.mjs";
import { endpoint, until } from "./a05-media.mjs";
import { uniqueEndpoint } from "./a04-binding.mjs";
import { runMigrations } from "../apps/api/dist-test/db.js";
import { withCallAdmission } from "../apps/api/dist-test/call-admission.js";
import { CallExecutor, enqueueCallCommand } from "../apps/api/dist-test/call-executor.js";
import { createCommandDriver } from "../apps/api/dist-test/call-command-transport.js";
const [mode, directory] = process.argv.slice(2);
assert.match(directory ?? "", /^\/tmp\/outbound-c03\.[A-Za-z0-9]+$/);
if (mode === "render") {
  await render(directory);
  process.exit(0);
}
assert.equal(mode, "probe");
const database = {
  host: join(directory, "socket"),
  database: "c03",
  user: "postgres",
  max: 8,
  connectionTimeoutMillis: 1000
};
const pool = new pg.Pool(database);
const children = [];
const executors = [];
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  media: "actual isolated SIP/FreeSWITCH jobs; no browser/provider; product executor and schema"
};
let observer, target;
const password = "a02-disposable-only";
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
let commandChain = Promise.resolve();
async function command(text) {
  const result = commandChain.then(() => observer.command(`api ${text}`));
  commandChain = result.catch(() => {});
  const body = (await result).body.trim();
  report.commands.push({ command: text, body });
  return body;
}
async function pass(name, evidence) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
function worker(config) {
  const child = fork(
    new URL("../tests/fixtures/inbound/executor-worker.mjs", import.meta.url),
    [JSON.stringify({ database: { ...database, user: "c03_executor" }, replica: 0, ...config })],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  children.push(child);
  const messages = [];
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("message", (m) => messages.push(m));
  const exited = once(child, "exit");
  return {
    child,
    exited,
    send: (type) => child.send({ type }),
    wait: async (type) =>
      until(
        () => {
          const failure = messages.find((m) => m.type === "failure");
          if (failure) throw new Error(JSON.stringify(failure));
          const at = messages.findIndex((m) => m.type === type);
          if (at >= 0) return messages.splice(at, 1)[0];
          if (child.exitCode !== null) throw new Error(`Worker exited: ${output}`);
        },
        `worker ${type}`,
        8000
      )
  };
}
const driver = (port = 8021) =>
  createCommandDriver({
    host: "127.0.0.1",
    port,
    password,
    buildCommand: (o) => o.request.command,
    verify: async (o, job) => ({
      state: job.body.trim().startsWith("+OK") || job.body.trim() === "false" ? "succeeded" : "failed",
      result: { job: job.jobUuid, reply: job.body.trim() },
      evidence: `actual BACKGROUND_JOB ${job.jobUuid}`
    }),
    reconcile: async () => null
  });
const noSend = {
  send: async () => {
    throw new Error("blind send forbidden");
  },
  reconcile: async () => null
};
let campaign;
async function enqueue(kind = "originate", cmd, callId, targetUuid = randomUUID()) {
  callId ??= (
    await pool.query(
      "insert into calls(campaign_id,destination_number,normalized_destination_number) values($1,'+14155550100','+14155550100') returning id",
      [campaign]
    )
  ).rows[0].id;
  const input = {
    id: randomUUID(),
    callId,
    scope: "c03-fs",
    key: randomUUID(),
    fingerprint: "e".repeat(64),
    kind,
    generation: "1",
    commandUuid: randomUUID(),
    targetUuid,
    request: { command: cmd },
    deadline: new Date(Date.now() + 120000)
  };
  const c = await pool.connect();
  try {
    await withCallAdmission(c, { callIds: [callId] }, async (a) => {
      await enqueueCallCommand(a, input);
    });
  } finally {
    c.release();
  }
  return input;
}
async function releaseCapacity(i, tokens) {
  const c = await pool.connect();
  try {
    return await withCallAdmission(c, { callIds: [i.callId] }, async (a) => {
      const outcomes = [];
      for (const t of tokens) outcomes.push(await a.capacity.release(t, true));
      return outcomes;
    });
  } finally {
    c.release();
  }
}
try {
  await runMigrations(pool);
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  await pool.query(
    "create role c03_executor login connection limit 8;grant usage on schema public to c03_executor;grant all on all tables in schema public to c03_executor;grant usage,select on all sequences in schema public to c03_executor"
  );
  campaign = (await pool.query("insert into campaigns(name,status) values('C03 FS','active') returning id"))
    .rows[0].id;
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
  assert.match(
    (
      await observer.command(
        "event plain BACKGROUND_JOB CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE CHANNEL_DESTROY CUSTOM"
      )
    ).headers["reply-text"],
    /^\+OK/
  );
  report.fs = await command("version");
  report.database = (await pool.query("select version()")).rows[0].version;
  const identity = { username: "desk_target", password: randomBytes(24).toString("hex") };
  await render(directory, [identity]);
  assert.match(await command("reloadxml"), /\+OK/);
  target = await endpoint({ ...identity, source: "127.0.0.4", frequency: 880 });
  await target.register();
  const destination = await until(
    async () =>
      uniqueEndpoint(
        await command(`sofia_contact a04-loopback/${identity.username}@a04.invalid`),
        identity.username
      ),
    "registered target"
  );
  const executor = await CallExecutor.create({ ...database, user: "c03_executor" }, 1);
  executors.push(executor);
  for (const fault of ["before-send", "delayed-send", "lost-ack"]) {
    const transport = await relay();
    const uuid = randomUUID();
    const start = observer.events.length,
      invites = target.invites.length;
    const i = await enqueue(
      "originate",
      `originate {origination_uuid=${uuid},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${destination} &park()`,
      undefined,
      uuid
    );
    const c = await pool.connect();
    let claims;
    try {
      claims = await withCallAdmission(c, { callIds: [i.callId] }, (a) =>
        a.capacity.claim({
          kind: "outbound_customer",
          callId: i.callId,
          operationId: i.id,
          generation: i.generation
        })
      );
    } finally {
      c.release();
    }
    const w = worker({ operationId: i.id, esl: { host: "127.0.0.1", port: transport.port, password } });
    let reaped = false;
    try {
      await w.wait("ready");
      w.send("go");
      await w.wait("sending");
      const attempt = (
        await pool.query("select * from call_execution_attempts where operation_id=$1", [i.id])
      ).rows[0];
      if (fault !== "before-send") {
        w.send("send");
        await until(() => transport.queued, "queued physical command");
      }
      if (fault === "lost-ack") {
        transport.forward();
        await until(
          () =>
            observer.events.some(
              (e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === i.commandUuid
            ),
          "job completed before lock loss"
        );
      }
      w.child.kill("SIGSTOP");
      await until(
        async () => /^State:\s+T/m.test(await readFile(`/proc/${w.child.pid}/status`, "utf8")),
        "sender stopped"
      );
      assert.equal(
        (await pool.query("select pg_terminate_backend($1) ok", [attempt.backend_pid])).rows[0].ok,
        true
      );
      const replacement = await until(async () => {
        const r = await executor.run(i.id, "normal", noSend);
        return r.status === "deferred" ? false : r;
      }, "replacement acquires call lock");
      assert.equal(replacement.status, "uncertain");
      assert.ok((await releaseCapacity(i, claims.tokens)).every((r) => !r));
      const absentAtTakeover = (await command(`uuid_exists ${uuid}`)) === "false";
      if (fault !== "lost-ack") assert.equal(absentAtTakeover, true);
      if (fault === "delayed-send") {
        transport.forward();
        await until(
          () =>
            observer.events.some(
              (e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === i.commandUuid
            ),
          "delayed actual job"
        );
      }
      w.child.kill("SIGCONT");
      if (fault === "before-send") w.send("send");
      await w.wait("done");
      await w.exited;
      reaped = true;
      await transport.close();
      const sends = transport.sends.length;
      assert.equal(sends, fault === "before-send" ? 0 : 1);
      if (sends) {
        await until(() => target.invites.length === invites + 1, "one real INVITE");
        assert.match(await command(`uuid_kill ${uuid} NORMAL_CLEARING`), /^\+OK/);
        await until(
          () =>
            observer.events
              .slice(start)
              .some((e) => e["event-name"] === "CHANNEL_HANGUP_COMPLETE" && e["unique-id"] === uuid),
          "exact terminal channel"
        );
      }
      assert.equal(await command(`uuid_exists ${uuid}`), "false");
      assert.equal(
        observer.events
          .slice(start)
          .filter((e) => e["event-name"] === "CHANNEL_CREATE" && e["unique-id"] === uuid).length,
        sends
      );
      const resolved = await executor.run(i.id, "critical", {
        ...noSend,
        reconcile: async () => ({
          state: sends ? "succeeded" : "failed",
          result: { sends, uuid },
          evidence: `lab coordinator: sender reaped, relay closed; exact job ${i.commandUuid} and terminal channel ${uuid} accounted; sends=${sends}`
        })
      });
      assert.equal(resolved.status, "terminal");
      assert.ok((await releaseCapacity(i, claims.tokens)).every(Boolean));
      const replay = await executor.run(i.id, "normal", noSend);
      assert.equal(replay.status, "terminal");
      await pass(`C03.1/C03.2 ${fault}`, {
        uuid,
        operation: i,
        attempt,
        absentAtTakeover,
        sends: transport.sends,
        invites: target.invites.length - invites,
        reaped,
        replacement,
        resolved,
        events: observer.events.slice(start)
      });
    } finally {
      if (!reaped && w.child.exitCode === null && w.child.signalCode === null) {
        w.child.kill("SIGCONT");
        w.child.kill("SIGKILL");
        await w.exited;
      }
      await transport.close();
    }
  }
  // Normal transport path exercises the product parser and exact Job-UUID observer.
  const liveUuid = randomUUID();
  const live = await enqueue(
    "originate",
    `originate {origination_uuid=${liveUuid},originate_timeout=3}${destination} &park()`,
    undefined,
    liveUuid
  );
  const liveResult = await executor.run(live.id, "normal", driver());
  assert.equal(liveResult.status, "terminal");
  assert.equal(liveResult.operation.state, "succeeded");
  await until(async () => (await command(`uuid_exists ${liveUuid}`)) === "true", "live control target");
  // Six normal seats across two replicas deliberately wait on real queued ESL bytes.
  const first = await CallExecutor.create({ ...database, user: "c03_executor" }, 0);
  executors.push(first);
  const held = [];
  const backlog = [];
  try {
    for (let n = 0; n < 6; n++) {
      const relaySocket = await relay();
      const op = await enqueue("originate", `uuid_exists ${randomUUID()}`);
      const executing = executors[n < 3 ? 0 : 1].run(op.id, "normal", driver(relaySocket.port));
      held.push({ relaySocket, op, executing });
      await until(() => relaySocket.queued, "saturated normal seat");
    }
    const hangup = await enqueue("hangup", `uuid_kill ${liveUuid} NORMAL_CLEARING`, live.callId, liveUuid);
    const began = performance.now();
    const ended = await executor.run(hangup.id, "critical", driver());
    assert.equal(ended.status, "terminal");
    await until(
      () =>
        observer.events.some(
          (e) => e["event-name"] === "CHANNEL_HANGUP_COMPLETE" && e["unique-id"] === liveUuid
        ),
      "reserved critical hangup"
    );
    const hangupMs = performance.now() - began;
    assert.ok(hangupMs <= 1000, `hangup ${hangupMs}ms`);
    await pass("C03.3 six delayed real transports preserve critical hangup", {
      hangupMs,
      stats: executors.map((e) => e.stats),
      operation: ended
    });
    // Fill and overflow the durable backlog while the normal transport fault remains.
    for (let n = 0; n < 64; n++)
      backlog.push(await enqueue(n < 48 ? "originate" : "hangup", `uuid_exists ${randomUUID()}`));
    await assert.rejects(enqueue("originate", `uuid_exists ${randomUUID()}`), /execution_backlog_full/);
    assert.ok(
      executors.every((e) => e.stats.running === 3),
      "normal executors remain held at overload"
    );
  } finally {
    for (const h of held) await h.relaySocket.close();
    await Promise.all(held.map((h) => h.executing));
    for (const h of held) {
      // Never forwarded: parent owns, closes and accounts for all relay bytes; no remote sender.
      const r = await executor.run(h.op.id, "critical", {
        ...noSend,
        reconcile: async () => ({
          state: "failed",
          result: { sends: 0 },
          evidence: "in-process sender settled, relay closed/discarded; no forwarded bytes"
        })
      });
      assert.equal(r.status, "terminal");
    }
  }
  for (const op of backlog) {
    const r = await executor.run(op.id, op.kind === "hangup" ? "critical" : "normal", driver());
    assert.equal(r.status, "terminal");
    assert.equal((await executor.run(op.id, "normal", noSend)).status, "terminal");
    await until(
      () =>
        observer.events.some((e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === op.commandUuid),
      "independent observer sees completed backlog job"
    );
    assert.equal(
      observer.events.filter((e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === op.commandUuid)
        .length,
      1,
      "exactly one real job per drained operation"
    );
  }
  assert.equal(
    (await pool.query("select count(*)::int n from call_operations where resolved_at is null")).rows[0].n,
    0
  );
  assert.equal(
    (await pool.query("select count(*)::int n from call_capacity_reservations where state<>'released'"))
      .rows[0].n,
    0
  );
  await until(async () => /0 total/.test(await command("show channels count")), "zero live channels");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from pg_locks where locktype='advisory' and classid in (72203,72204)"
      )
    ).rows[0].n,
    0
  );
  await pass("C03.4 bounded backlog refusal and fault-clear drain", {
    backlog: backlog.length,
    operations: (await pool.query("select * from call_operations order by created_at")).rows,
    attempts: (await pool.query("select * from call_execution_attempts")).rows,
    jobs: observer.events.filter((e) => e["event-name"] === "BACKGROUND_JOB")
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await save();
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGCONT");
      child.kill("SIGKILL");
      await exited;
    }
  target?.close();
  observer?.close();
  await Promise.all(executors.map((e) => e.close()));
  await pool.end();
}
