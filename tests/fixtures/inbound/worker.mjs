// Harness-only state model. It does not implement product admission or media control.
import assert from "node:assert/strict";
import pg from "pg";
import { databaseConfig, testDatabaseUrl } from "./database.mjs";

const [schema, operation] = process.argv.slice(2);
// A killed parent cannot leave a barrier process or DB transaction running.
const parentLost = () => process.exit(1);
process.on("disconnect", parentLost);
setTimeout(() => process.exit(1), 15000).unref();
assert.match(schema, /^inbound_fixture_[a-f0-9]{16}$/);
assert.match(operation, /^[ab]$/);
const db = new pg.Client(databaseConfig(testDatabaseUrl(), schema));
const queue = [];
let wake;
process.on("message", (message) => {
  queue.push(message);
  wake?.();
});
async function checkpoint(type) {
  process.send({ type });
  if (!queue.length)
    await new Promise((resolve) => {
      wake = resolve;
    });
  wake = undefined;
  return queue.shift();
}
await db.connect();
try {
  const backend = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  process.send({ type: "before-claim", pid: process.pid, backend });
  if (!queue.length)
    await new Promise((resolve) => {
      wake = resolve;
    });
  wake = undefined;
  queue.shift();
  await db.query("BEGIN");
  process.send({ type: "claiming" });
  // Fixture row locks, scoped to this run's schema. Recheck only after the lock wait.
  await db.query("LOCK TABLE claims IN EXCLUSIVE MODE");
  if ((await db.query("SELECT * FROM claims WHERE resource='slot' FOR UPDATE")).rowCount) {
    await db.query("ROLLBACK");
    process.send({ type: "lost" });
  } else {
    await db.query("INSERT INTO claims VALUES('slot',$1)", [operation]);
    await db.query("INSERT INTO work VALUES($1,'claimed')", [operation]);
    const action = await checkpoint("before-commit");
    if (action.type === "rollback") {
      await db.query("ROLLBACK");
      process.send({ type: "rolled-back" });
    } else {
      await db.query("COMMIT");
      await checkpoint("before-send");
      await db.query("UPDATE work SET state='uncertain' WHERE operation=$1", [operation]);
      await db.query("INSERT INTO ledger(operation,stage) VALUES($1,'sent')", [operation]);
      await checkpoint("after-send-before-ack");
      await db.query("INSERT INTO ledger(operation,stage) VALUES($1,'ack'),($1,'bridge')", [operation]);
      await checkpoint("after-bridge-before-persistence");
      await db.query("UPDATE work SET state='persisted' WHERE operation=$1", [operation]);
      process.send({ type: "done" });
    }
  }
} finally {
  await db.end();
  process.off("disconnect", parentLost);
  process.disconnect();
}
