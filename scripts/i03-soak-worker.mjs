// Explicit disposable lab configuration over IPC.
import Fastify from "fastify";
import pg from "pg";
import { registerCallOfferRoutes } from "../apps/api/dist-test/dashboard/call-offers.js";
import { CallExecutor } from "../apps/api/dist-test/call-executor.js";
import { inboundConnectionExecutor } from "../apps/api/dist-test/inbound-connection.js";

process.once("disconnect", () => process.exit(1));
process.once("message", async ({ mode, database, config, executor, esl }) => {
  const pool = new pg.Pool({ ...database, max: 4 });
  if (mode === "api") {
    const app = Fastify({ forceCloseConnections: true });
    registerCallOfferRoutes(app, config, pool, { async wakeExecutor() {} });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    process.send({ type: "ready", address });
    process.once("SIGTERM", async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  } else {
    const runner = await CallExecutor.create(executor, 1);
    const runtime = inboundConnectionExecutor(pool, runner, esl);
    process.on("message", async ({ id }) => {
      try {
        await runtime.wakeExecutor(id);
        process.send({ type: "done", id });
      } catch (error) {
        process.send({ type: "error", id, error: error.message });
      }
    });
    process.send({ type: "ready" });
    process.once("SIGTERM", async () => {
      await runner.close();
      await pool.end();
      process.exit(0);
    });
  }
});
