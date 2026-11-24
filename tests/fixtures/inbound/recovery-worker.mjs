// Separate OS process, real C03 executor/locks; only native probes are simulated.
import { once } from "node:events";
import { CallExecutor } from "../../../apps/api/dist-test/call-executor.js";
import { recoverQuiescentCall } from "../../../apps/api/dist-test/inbound-recovery.js";
import pg from "pg";
const input = JSON.parse(process.env.INBOUND_FIXTURE_WORKER_CONFIG);
const pool = new pg.Pool(input.database);
const executor = await CallExecutor.create(input.database, 1);
const guard = setTimeout(() => process.exit(1), 15000);
let probed = false;
try {
  const go = once(process, "message");
  process.send({ type: "ready" });
  await go;
  const result = await recoverQuiescentCall(
    pool,
    executor,
    input.callId,
    async () => {
      if (!probed) {
        probed = true;
        const resume = once(process, "message");
        process.send({ type: "probing" });
        await resume;
      }
      return "false";
    },
    () => true
  );
  process.send({ type: "done", result });
} catch (error) {
  process.send({ type: "failure", message: error.message });
} finally {
  await executor.close();
  await pool.end();
  clearTimeout(guard);
  process.disconnect();
}
