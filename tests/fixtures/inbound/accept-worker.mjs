// Independent E02 HTTP-domain claimant with observable PostgreSQL barriers.
import pg from "pg";
import { acceptInboundOffer } from "../../../apps/api/dist-test/inbound-acceptance.js";
const input = JSON.parse(process.argv[2]);
const pool = new pg.Pool({ ...input.config, max: 1 });
const queue = [];
let receive;
process.on("message", (message) => {
  queue.push(message);
  receive?.();
});
async function wait(type) {
  while (true) {
    const i = queue.findIndex((m) => m.type === type);
    if (i >= 0) return queue.splice(i, 1)[0];
    await new Promise((resolve) => {
      receive = resolve;
    });
    receive = undefined;
  }
}
try {
  const backend = (await pool.query("select pg_backend_pid() as pid")).rows[0].pid;
  process.send({ type: "ready", backend });
  await wait("start");
  const result = await acceptInboundOffer(
    pool,
    input.actor,
    input.offerId,
    input.intent,
    input.hold
      ? async () => {
          process.send({ type: "claimed", backend });
          const m = await wait("finish");
          if (m.rollback) throw new Error("injected_rollback");
        }
      : undefined
  );
  process.send({ type: "result", result });
} catch (error) {
  process.send({ type: "result", error: error.message });
} finally {
  await pool.end();
  process.disconnect();
}
