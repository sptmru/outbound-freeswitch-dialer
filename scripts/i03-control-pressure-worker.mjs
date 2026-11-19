// Runs inside the disposable C03 network namespace with its generated DB roles.
import { createCallControlPools } from "../apps/api/dist-test/call-control-pools.js";
import { withCallAdmission } from "../apps/api/dist-test/call-admission.js";
import { setTimeout as delay } from "node:timers/promises";
import { budgets } from "./a06-budgets.mjs";
import { summarizeLatency } from "./inbound-load-measurements.mjs";
import { once } from "node:events";

process.once("disconnect", () => process.exit(1));
process.once("message", async ({ configs, replica }) => {
  const pools = await createCallControlPools(configs, "c03_executor");
  const resume = once(process, "message");
  process.send({ type: "ready" });
  await resume;
  const progress = await Promise.all(
    ["admission", "heartbeat", "events", "recovery"].map(async (lane) => {
      const pool = pools[lane];
      const latencies = [];
      const acquisition = [];
      const stages = [];
      const failures = [];
      const startedAt = performance.now();
      for (let sequence = 0; sequence < 120; sequence++) {
        const offeredAt = startedAt + 25 * sequence;
        await delay(Math.max(0, offeredAt - performance.now()));
        const acquiringAt = performance.now();
        let db, acquiredAt, writeStartedAt, writeFinishedAt;
        let outcome = "ok";
        try {
          db = await pool.connect();
          acquiredAt = performance.now();
          const write = async () => {
            writeStartedAt = performance.now();
            await db.query("insert into i03_control_progress(replica,lane,sequence) values($1,$2,$3)", [
              replica,
              lane,
              sequence
            ]);
            writeFinishedAt = performance.now();
          };
          if (lane === "admission") await withCallAdmission(db, {}, write);
          else await write();
        } catch (error) {
          outcome = "error";
          failures.push({ sequence, code: error.code, message: error.message });
        } finally {
          const finishedAt = performance.now();
          const acquisitionMs = (acquiredAt ?? finishedAt) - acquiringAt;
          acquisition.push({
            ms: acquisitionMs,
            outcome: db ? "ok" : "error"
          });
          stages.push({
            sequence,
            outcome,
            schedulingMs: Math.max(0, acquiringAt - offeredAt),
            acquisitionMs,
            beforeWriteMs: writeStartedAt === undefined ? null : writeStartedAt - acquiredAt,
            writeMs: writeFinishedAt === undefined ? null : writeFinishedAt - writeStartedAt,
            afterWriteMs: writeFinishedAt === undefined ? null : finishedAt - writeFinishedAt
          });
          db?.release();
          latencies.push({ ms: finishedAt - offeredAt, outcome });
        }
      }
      return {
        lane,
        failures,
        latencies,
        acquisition,
        stages,
        acquired: summarizeLatency(acquisition, [budgets.acquireMs, budgets.acquireMs]),
        result: summarizeLatency(latencies, [budgets.controlP95Ms, budgets.controlP99Ms]),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiters: pool.waitingCount }
      };
    })
  );
  await pools.close();
  process.send({ type: "done", replica, progress }, () => process.exit(0));
});
