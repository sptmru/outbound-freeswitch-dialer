// Actual product entry points in a separate OS process. IPC holds COMMIT only;
// database locks, revalidation and rollback remain product behavior.
import pg from "pg";
import { once } from "node:events";
import { databaseConfig, testDatabaseUrl } from "./database.mjs";
import { reconcileCoordinatedCallCleanup } from "../../../apps/api/dist-test/call-cleanup.js";
import { admitManualOutbound } from "../../../apps/api/dist-test/manual-outbound.js";
const [schema, raw] = process.argv.slice(2),
  input = JSON.parse(raw);
const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 1 });
const timer = setTimeout(() => process.exit(1), 15000);
timer.unref();
process.once("disconnect", () => process.exit(1));
const send = (type, extra = {}) =>
  new Promise((resolve, reject) => process.send({ type, ...extra }, (e) => (e ? reject(e) : resolve())));
const client = await pool.connect();
const backend = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
client.release();
const connect = pool.connect.bind(pool);
pool.connect = async () => {
  const db = await connect(),
    query = db.query.bind(db),
    release = db.release.bind(db);
  db.query = async (...args) => {
    if (args[0] === "commit") {
      const reply = once(process, "message");
      await send("before-commit");
      const [message] = await reply;
      if (message.type === "rollback") throw new Error("fixture_rollback");
    }
    return query(...args);
  };
  db.release = () => {
    db.query = query;
    db.release = release;
    release();
  };
  return db;
};
try {
  const go = once(process, "message");
  await send("ready", { pid: process.pid, backend });
  await go;
  try {
    const result =
      input.mode === "cleanup"
        ? await reconcileCoordinatedCallCleanup(pool, input.callId)
        : await admitManualOutbound(
            pool,
            { DEFAULT_PHONE_COUNTRY_CODE: "US", CONTACT_MAX_ATTEMPTS: 3, CONTACT_RETRY_DELAY_SECONDS: 900 },
            input.request
          );
    await send("committed", { result });
  } catch (error) {
    await send("rejected", { reason: error.reason ?? error.message });
  }
} finally {
  await pool.end();
  clearTimeout(timer);
  process.removeAllListeners("disconnect");
  process.disconnect();
}
