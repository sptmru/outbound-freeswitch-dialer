// Isolated process for the A06 DB prototype; never accepts DATABASE_URL/.env.
import assert from "node:assert/strict";
import net from "node:net";
import pg from "pg";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { budgets as b } from "./a06-budgets.mjs";

const [mode, directory, replica] = process.argv.slice(2);
assert.match(directory, /^\/tmp\/outbound-a06\.[\w]+$/);
const pools = [];
const poolFor = (user, max) => {
  const pool = new pg.Pool({
    host: `${directory}/socket`,
    database: "a06",
    user,
    max,
    connectionTimeoutMillis: b.acquireMs,
    options: `-c statement_timeout=${b.statementMs} -c lock_timeout=${b.lockMs}`
  });
  pools.push(pool);
  return pool;
};
const waitFor = (type) =>
  new Promise((resolve) => {
    const handler = (message) => {
      if (message.type === type) {
        process.off("message", handler);
        resolve(message);
      }
    };
    process.on("message", handler);
  });

async function execute(pool, id, wave) {
  const db = await pool.connect();
  let socket;
  try {
    await db.query("SELECT pg_advisory_lock(72204,$1)", [id]);
    await db.query(
      "INSERT INTO operations(id,wave,state,backend) VALUES($1,$2,'uncertain',pg_backend_pid())",
      [id, wave]
    );
    // Same leased session persists both result and uncertainty; no transaction in ESL wait.
    const commandStarted = performance.now();
    const reply = await new Promise((resolve, reject) => {
      socket = net.createConnection(`${directory}/esl.sock`);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("command_deadline"));
      }, b.commandMs);
      socket.on("connect", () => socket.write(`${id}\n`));
      socket.once("data", () => {
        clearTimeout(timer);
        resolve("done");
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }).catch((error) => {
      if (error.message !== "command_deadline") throw error;
      return "uncertain";
    });
    await db.query("UPDATE operations SET state=$2,persist_backend=pg_backend_pid() WHERE id=$1", [
      id,
      reply
    ]);
    return { id, state: reply, commandMs: performance.now() - commandStarted };
  } finally {
    socket?.destroy();
    await db.query("SELECT pg_advisory_unlock(72204,$1)", [id]);
    db.release();
  }
}

try {
  if (mode === "executor") {
    const pool = poolFor("a06_executor", b.executorPerWorker);
    process.send({ type: "ready" });
    for (let wave = 0; wave < 2; wave++) {
      await waitFor("wave");
      const operations = Array.from({ length: b.executorPerWorker }, (_, i) =>
        execute(pool, 1 + wave * 8 + Number(replica) * 4 + i, wave)
      );
      await waitFor("probe-pool");
      assert.equal(pool.totalCount, 4);
      assert.equal(pool.idleCount, 0);
      const start = performance.now();
      await assert.rejects(pool.connect(), /timeout/i);
      const acquisitionMs = performance.now() - start;
      assert.ok(acquisitionMs >= b.acquireMs * 0.8 && acquisitionMs < b.acquireMs + 250);
      assert.equal(pool.waitingCount, 0);
      process.send({
        type: "pool-probed",
        acquisitionMs,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiters: pool.waitingCount
      });
      const result = await Promise.all(operations);
      assert.equal(pool.waitingCount, 0);
      process.send({ type: "wave-done", wave, result });
    }
  } else {
    assert.equal(mode, "api");
    const sizes = {
      admission: b.admissionPool,
      heartbeat: b.heartbeatPool,
      event: b.eventPool,
      recovery: b.recoveryPool
    };
    const lanes = Object.fromEntries(
      Object.entries(sizes).map(([lane, size]) => [lane, poolFor(`a06_${lane}`, size)])
    );
    process.send({ type: "ready" });
    await waitFor("load");
    const stats = await Promise.all(
      Object.entries(lanes).map(async ([lane, pool]) => {
        const durations = [],
          acquisitions = [];
        const began = performance.now();
        for (let i = 0; i < 120; i++) {
          await delay(Math.max(0, began + i * 25 - performance.now()));
          const scheduled = began + i * 25;
          const start = performance.now();
          const db = await pool.connect();
          acquisitions.push(performance.now() - start);
          try {
            await db.query("BEGIN");
            // Model shared admission contention. Other lanes use independent durable rows.
            if (lane === "admission") await db.query("SELECT pg_advisory_xact_lock(72205,1)");
            await db.query("INSERT INTO control_progress(replica,lane,sequence) VALUES($1,$2,$3)", [
              replica,
              lane,
              i
            ]);
            await db.query("COMMIT");
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          } finally {
            db.release();
          }
          durations.push(performance.now() - scheduled); // Includes scheduling/queue delay.
        }
        return { lane, durations, acquisitions, total: pool.totalCount, waiters: pool.waitingCount };
      })
    );
    process.send({ type: "load-done", stats });
  }
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
  process.disconnect();
}
