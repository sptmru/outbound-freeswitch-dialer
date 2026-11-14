// Single disposable executor process. Its dedicated DB session owns the lock.
import assert from "node:assert/strict";
import pg from "pg";
import { openEsl } from "./a02-ingress-probe.mjs";

const config = JSON.parse(process.argv[2]);
assert.ok(config.directory.startsWith("/tmp/outbound-a05."));
const db = new pg.Client({
  host: `${config.directory}/socket`,
  database: "a05",
  user: "postgres",
  connectionTimeoutMillis: 1000,
  query_timeout: 3000,
  options: "-c statement_timeout=3000"
});
let lost = false;
let esl;
db.on("error", () => {
  lost = true;
  process.send?.({ type: "lock-lost" });
});
db.on("end", () => {
  lost = true;
});
function checkpoint(type, extra = {}) {
  return new Promise((resolve) => {
    process.once("message", resolve);
    process.send({ type, ...extra });
  });
}
try {
  await db.connect();
  await db.query("SELECT pg_advisory_lock(72203,$1)", [config.key]);
  const result = await db.query(
    `UPDATE a05_operations SET state='uncertain',worker_pid=$2,backend_pid=pg_backend_pid()
    WHERE lock_key=$1 AND state='reserved' RETURNING backend_pid`,
    [config.key, process.pid]
  );
  assert.equal(result.rowCount, 1);
  esl = await openEsl({ port: config.port });
  await checkpoint("prepared", { backend: result.rows[0].backend_pid });
  // A lost connection is latched permanently; a new pool connection cannot restore ownership.
  if (lost) throw new Error("Execution lock lost before send");
  await db.query("SELECT 1");
  if (lost) throw new Error("Execution lock lost before send");
  process.send({ type: "sending" });
  const reply = await esl.command(`bgapi ${config.command}\nJob-UUID: ${config.job}`);
  process.send({ type: "response", headers: reply.headers });
  await checkpoint("after-response");
} catch (error) {
  process.send?.({ type: "stopped", error: error.message });
} finally {
  esl?.close();
  await db.end().catch(() => {});
  process.disconnect();
}
