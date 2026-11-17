import pg from "pg";
import { mutateTransferOffer } from "../../../apps/api/dist-test/transfer-offers.js";
import { AdmissionDiscoveryChanged, withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
import { acceptInboundOffer } from "../../../apps/api/dist-test/inbound-acceptance.js";
import Fastify from "fastify";
import { registerDashboardRoutes } from "../../../apps/api/dist-test/dashboard/routes.js";
const input = JSON.parse(process.argv[2]);
const pool = new pg.Pool({ ...input.config, max: 1 });
const messages = [];
let wake;
process.on("message", (m) => {
  messages.push(m);
  wake?.();
});
async function wait(type) {
  while (true) {
    const i = messages.findIndex((m) => m.type === type);
    if (i >= 0) return messages.splice(i, 1)[0];
    await new Promise((r) => (wake = r));
  }
}
let app, backend;
pool.on("connect", (client) => {
  const query = client.query.bind(client);
  client.query = (sql, ...args) => {
    if (sql === "commit" && input.hold)
      return (async () => {
        process.send({ type: "claimed", backend });
        const message = await wait("finish");
        if (message.rollback) throw new Error("injected_rollback");
        return query(sql, ...args);
      })();
    return query(sql, ...args);
  };
});
try {
  backend = (await pool.query("select pg_backend_pid() pid")).rows[0].pid;
  process.send({ type: "ready", backend });
  await wait("start");
  let result;
  if (input.mode === "transfer")
    result = await mutateTransferOffer(pool, input.actor, input.offerId, input.intent, "accept");
  else if (input.mode === "inbound")
    result = await acceptInboundOffer(pool, input.actor, input.offerId, input.intent);
  else if (input.mode === "terminal") {
    const db = await pool.connect();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await withCallAdmission(db, { callIds: [input.callId] }, async () => {
            await db.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
              input.callId
            ]);
            return { status: "terminal" };
          });
          break;
        } catch (error) {
          if (!(error instanceof AdmissionDiscoveryChanged) || attempt === 2) throw error;
        }
      }
    } finally {
      db.release();
    }
  } else {
    app = Fastify();
    registerDashboardRoutes(app, input.httpConfig, pool, undefined, { async wakeExecutor() {} });
    const response = await app.inject(input.http);
    result = { statusCode: response.statusCode, body: response.json() };
  }
  process.send({ type: "result", result });
} catch (error) {
  process.send({ type: "result", error: error.message });
} finally {
  await app?.close();
  await pool.end();
  process.disconnect();
}
