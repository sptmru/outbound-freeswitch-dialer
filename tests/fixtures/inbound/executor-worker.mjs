import pg from "pg";
import { CallExecutor } from "../../../apps/api/dist-test/call-executor.js";
import { createCommandDriver } from "../../../apps/api/dist-test/call-command-transport.js";
import { withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
import { enqueueCallCommand } from "../../../apps/api/dist-test/call-executor.js";
const config = JSON.parse(process.env.INBOUND_FIXTURE_WORKER_CONFIG ?? process.argv[2]);
const messages = [];
let wake;
process.on("message", (m) => {
  messages.push(m);
  wake?.();
});
async function checkpoint(type, extra = {}) {
  process.send({ type, pid: process.pid, ...extra });
  while (!messages.length)
    await new Promise((r) => {
      wake = r;
    });
  wake = undefined;
  return messages.shift();
}
let executor;
let control;
try {
  if (config.enqueue) {
    control = new pg.Pool(config.database);
    const c = await control.connect();
    try {
      await checkpoint("ready", { backend: (await c.query("select pg_backend_pid() as pid")).rows[0].pid });
      const result = await withCallAdmission(c, { callIds: [config.enqueue.callId] }, async (a) => {
        const result = await enqueueCallCommand(a, {
          ...config.enqueue,
          deadline: new Date(config.enqueue.deadline)
        });
        const decision = await checkpoint("enqueued", { result });
        if (decision.type === "rollback") throw new Error("fixture_rollback");
        return result;
      });
      process.send({ type: "done", result });
    } finally {
      c.release();
    }
  } else {
    executor = await CallExecutor.create(config.database, config.replica);
    const driver = config.esl
      ? createCommandDriver({
          ...config.esl,
          buildCommand: (o) => o.request.command,
          verify: async (o, job) => ({
            state: job.body.trim().startsWith("+OK") ? "succeeded" : "failed",
            result: { jobUuid: job.jobUuid, reply: job.body.trim() },
            evidence: `actual BACKGROUND_JOB ${job.jobUuid}`
          }),
          reconcile: async () => null
        })
      : {
          async send(o, signal) {
            await checkpoint("sending", { id: o.id, commandUuid: o.command_uuid, aborted: signal.aborted });
            if (signal.aborted) return null;
            return {
              state: "succeeded",
              result: { simulated: true },
              evidence: "controlled simulated command completion"
            };
          },
          async reconcile(o) {
            process.send({ type: "reconciling", id: o.id });
            return null;
          }
        };
    if (config.esl) {
      const send = driver.send.bind(driver);
      driver.send = async (o, signal) => {
        await checkpoint("sending", { id: o.id });
        if (signal.aborted) return null;
        return send(o, signal);
      };
    }
    await checkpoint("ready");
    process.send({
      type: "done",
      result: await executor.run(config.operationId, config.priority ?? "normal", driver)
    });
  }
} catch (error) {
  process.send?.({ type: "failure", message: error.message, code: error.code });
} finally {
  await executor?.close();
  await control?.end();
  process.disconnect();
}
