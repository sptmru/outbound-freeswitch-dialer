import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { budgets as b, validateBudgets, percentile } from "./a06-budgets.mjs";

const directory = process.argv[2];
assert.match(directory, /^\/tmp\/outbound-a06\.[\w]+$/);
const pool = new pg.Pool({
  host: `${directory}/socket`,
  database: "a06",
  user: "postgres",
  max: 2,
  connectionTimeoutMillis: 1000
});
const children = [],
  messages = [],
  sockets = new Map(),
  ledger = [];
const server = net.createServer((socket) => {
  let data = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    data += chunk.toString();
    if (!data.endsWith("\n")) return;
    const id = Number(data.trim());
    assert.ok(Number.isInteger(id) && id > 0 && id <= 16);
    assert.ok(!sockets.has(id), "Duplicate simulated command");
    sockets.set(id, socket);
    ledger.push({ id, at: performance.now() });
  });
});
async function until(fn, label, timeout = 10000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out: ${label}`);
}
function start(mode, replica) {
  const child = fork(
    new URL("./a06-budget-worker.mjs", import.meta.url),
    [mode, directory, String(replica)],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  child.on("message", (message) => messages.push({ pid: child.pid, mode, replica, ...message }));
  const ended = once(child, "exit").then(([code, signal]) => ({ code, signal, log: log.join("") }));
  const handle = { child, ended };
  children.push(handle);
  return handle;
}
const report = {
  base: "958aa29ff6545798958c63945833b40c4e0b57fe",
  scope: "A06 DB-only; simulated ESL, no SIP/RTP/provider",
  budgets: b,
  aggregate: validateBudgets(),
  hardware: {
    cpus: os.availableParallelism(),
    cpu: os.cpus()[0].model,
    memoryBytes: os.totalmem(),
    node: process.version
  },
  waves: []
};
try {
  await pool.query(`CREATE TABLE operations(id integer PRIMARY KEY,wave integer,state text CHECK(state IN ('uncertain','done','resolved')),backend integer,persist_backend integer);
    CREATE TABLE control_progress(replica integer,lane text,sequence integer,PRIMARY KEY(replica,lane,sequence));
    CREATE TABLE backlog(id integer PRIMARY KEY);`);
  for (const [lane, limit] of Object.entries({
    executor: 8,
    admission: 8,
    heartbeat: 2,
    event: 4,
    recovery: 2
  })) {
    // Fixed repo-owned identifiers, isolated trust-only database.
    await pool.query(
      `CREATE ROLE a06_${lane} LOGIN CONNECTION LIMIT ${limit}; GRANT USAGE ON SCHEMA public TO a06_${lane}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO a06_${lane}`
    );
  }
  report.database = (
    await pool.query("SELECT version(),current_setting('max_connections') AS max_connections")
  ).rows[0];
  server.listen(`${directory}/esl.sock`);
  await once(server, "listening");
  const executors = [start("executor", 0), start("executor", 1)];
  const apis = [start("api", 0), start("api", 1)];
  await until(() => messages.filter((m) => m.type === "ready").length === 4, "all replicas ready");
  for (let wave = 0; wave < 2; wave++) {
    for (const { child } of executors) child.send({ type: "wave" });
    await until(() => sockets.size === (wave + 1) * 8, "all eight commands blocked");
    const active = (
      await pool.query(
        "SELECT state,xact_start FROM pg_stat_activity WHERE usename='a06_executor' ORDER BY pid"
      )
    ).rows;
    assert.equal(active.length, 8);
    assert.ok(active.every((row) => row.state === "idle" && row.xact_start === null));
    const excess = new pg.Client({
      host: `${directory}/socket`,
      database: "a06",
      user: "a06_executor",
      connectionTimeoutMillis: b.acquireMs
    });
    await assert.rejects(excess.connect(), { code: "53300" });
    await excess.end();
    for (const { child } of executors) child.send({ type: "probe-pool" });
    await until(
      () => messages.filter((m) => m.type === "pool-probed").length === (wave + 1) * 2,
      "bounded pool acquisition"
    );
    let control;
    if (wave === 0) {
      for (const { child } of apis) child.send({ type: "load" });
      await until(
        () => messages.filter((m) => m.type === "load-done").length === 2,
        "all protected control paths progress"
      );
      control = messages
        .filter((m) => m.type === "load-done")
        .flatMap((m) => m.stats.map((stat) => ({ replica: m.replica, ...stat })));
      for (const stat of control) {
        assert.equal(stat.durations.length, 120);
        assert.equal(stat.waiters, 0);
        stat.p95 = percentile(stat.durations, 0.95);
        stat.p99 = percentile(stat.durations, 0.99);
        stat.acquireP99 = percentile(stat.acquisitions, 0.99);
        assert.ok(stat.p95 <= b.controlP95Ms, JSON.stringify(stat));
        assert.ok(stat.p99 <= b.controlP99Ms, JSON.stringify(stat));
      }
      assert.equal(Number((await pool.query("SELECT count(*) FROM control_progress")).rows[0].count), 960);
      assert.equal(
        Number((await pool.query("SELECT count(*) FROM operations WHERE state='uncertain'")).rows[0].count),
        8
      );
      for (const socket of sockets.values()) socket.write("+OK simulated\n");
    }
    await until(
      () => messages.filter((m) => m.type === "wave-done" && m.wave === wave).length === 2,
      "same-session persistence"
    );
    const rows = (await pool.query("SELECT * FROM operations WHERE wave=$1 ORDER BY id", [wave])).rows;
    assert.equal(rows.length, 8);
    assert.ok(rows.every((row) => row.backend === row.persist_backend));
    assert.ok(rows.every((row) => row.state === (wave === 0 ? "done" : "uncertain")));
    const started = performance.now();
    if (wave === 1) {
      for (const handle of executors) {
        const result = await handle.ended;
        assert.equal(result.code, 0, result.log);
      }
      // Stub-only conclusive reconciliation: sockets are closed and the ledger
      // records exactly one completed simulated action per id. No physical FS claim.
      await until(
        () => [...sockets.values()].every((s) => s.destroyed || s.readableEnded),
        "closed sender transports"
      );
      await pool.query("UPDATE operations SET state='resolved' WHERE wave=1 AND state='uncertain'");
    }
    assert.ok(performance.now() - started <= b.recoveryMs);
    report.waves.push({ wave, active, control, rows, recoveryMs: performance.now() - started });
  }
  // Real DB bound under a shared transaction gate, including rollback at capacity.
  for (let id = 1; id <= 65; id++) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(72205,2)");
      const n = Number((await db.query("SELECT count(*) FROM backlog")).rows[0].count);
      if (n < 64) {
        await db.query("INSERT INTO backlog VALUES($1)", [id]);
        await db.query("COMMIT");
      } else {
        assert.equal(id, 65);
        await db.query("ROLLBACK");
      }
    } finally {
      db.release();
    }
  }
  assert.equal(Number((await pool.query("SELECT count(*) FROM backlog")).rows[0].count), 64);
  await pool.query("DELETE FROM backlog");
  for (const handle of children) {
    const result = await handle.ended;
    assert.equal(result.code, 0, result.log);
  }
  assert.equal(ledger.length, 16);
  assert.equal(new Set(ledger.map((x) => x.id)).size, 16);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM operations WHERE state='uncertain'")).rows[0].count),
    0
  );
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=72204")).rows[0]
        .count
    ),
    0
  );
  report.ledger = ledger;
  report.messages = messages;
  report.cleanup = {
    uncertain: 0,
    executionLocks: 0,
    backlog: 0,
    commands: 16,
    duplicates: 0,
    controlWrites: 960
  };
  report.result = "PASS";
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        result: report.result,
        cleanup: report.cleanup,
        latencies: report.waves[0].control.map(({ replica, lane, p95, p99, acquireP99 }) => ({
          replica,
          lane,
          p95,
          p99,
          acquireP99
        }))
      },
      null,
      2
    )
  );
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  throw error;
} finally {
  for (const { child } of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(children.map((h) => h.ended));
  for (const socket of sockets.values()) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
