// C04 real SQL contenders; all media/execution is absent.
import pg from "pg";
import { once } from "node:events";
import { databaseConfig, testDatabaseUrl } from "./database.mjs";
import { admitManualOutbound } from "../../../apps/api/dist-test/manual-outbound.js";
import { AdmissionDiscoveryChanged, withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
const [schema, raw] = process.argv.slice(2),
  input = JSON.parse(raw);
const lifetime = setTimeout(() => process.exit(1), 15000);
lifetime.unref();
process.once("disconnect", () => process.exit(1));
const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
const send = (type, extra = {}) =>
  new Promise((resolve, reject) => process.send({ type, ...extra }, (e) => (e ? reject(e) : resolve())));
const connect = pool.connect.bind(pool);
pool.connect = async () => {
  const c = await connect();
  await send("connected", {
    backend: (await c.query("select pg_backend_pid() as pid")).rows[0].pid,
    pid: process.pid
  });
  const query = c.query.bind(c);
  c.query = async (sql, ...args) => {
    if (typeof sql === "string" && sql === "commit") {
      const continuation = once(process, "message");
      await send("before-commit");
      const [message] = await continuation;
      if (message.type === "rollback") throw new Error("fixture_rollback");
    }
    return query(sql, ...args);
  };
  return c;
};
try {
  const start = once(process, "message");
  await send("ready");
  await start;
  let result;
  if (input.mode === "manual") result = await admitManualOutbound(pool, input.config, input.request);
  else {
    const client = await pool.connect();
    try {
      const run = () =>
        withCallAdmission(
          client,
          { agentIds: [input.agentId], callIds: [input.callId], campaignIds: [input.campaignId] },
          async (a) => {
            if (input.mode === "terminal") {
              await client.query(
                "update calls set state='completed',ended_at=clock_timestamp() where id=$1",
                [input.callId]
              );
              await client.query(
                "update call_offers set state='canceled',reason='call_closed',closed_at=clock_timestamp() where call_id=$1 and state='pending'",
                [input.callId]
              );
              await client.query(
                "update call_transfers set state='canceled',reason='call_closed',closed_at=clock_timestamp() where call_id=$1 and closed_at is null",
                [input.callId]
              );
              return "terminal";
            }
            const token = await a.reserve(input, input.callId);
            await client.query(
              "update call_offers set state='accepted',reason='explicit_accept',closed_at=clock_timestamp() where id=$1",
              [input.offerId]
            );
            if (input.transferId)
              await client.query("update call_transfers set state='connecting' where id=$1", [
                input.transferId
              ]);
            else {
              await client.query(
                "update calls set state='connecting',agent_id=$2,queue_exited_at=clock_timestamp() where id=$1",
                [input.callId, input.agentId]
              );
              await client.query(
                "update call_offers set state='canceled',reason='winner_accepted',closed_at=clock_timestamp() where call_id=$1 and state='pending'",
                [input.callId]
              );
            }
            return token;
          }
        );
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await run();
          break;
        } catch (error) {
          if (!(error instanceof AdmissionDiscoveryChanged) || attempt === 2) throw error;
        }
      }
    } finally {
      client.release();
    }
  }
  await send("committed", { result });
} catch (error) {
  await send("rejected", { reason: error.reason ?? error.message });
} finally {
  await pool.end();
  clearTimeout(lifetime);
  process.removeAllListeners("disconnect");
  process.disconnect();
}
