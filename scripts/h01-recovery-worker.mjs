// Real replacement worker process. Explicit disposable configuration over IPC;
// no application environment or production bootstrap is read.
import pg from "pg";
import { once } from "node:events";
import { CallExecutor } from "../apps/api/dist-test/call-executor.js";
import { lifecycleRecoveryRuntime } from "../apps/api/dist-test/lifecycle-recovery-runtime.js";
import { startFreeSwitchEventListener } from "../apps/api/dist-test/esl-events.js";
import { createInboundQueueCoordinator } from "../apps/api/dist-test/inbound-queue.js";
import { sendFreeSwitchApiCommand } from "../apps/api/dist-test/esl.js";
process.once("disconnect", () => process.exit(1));
process.once("message", async (input) => {
  const pool = new pg.Pool({ ...input.database, max: 3 });
  const executor = await CallExecutor.create(input.executor, 1);
  if (input.waitForResume) {
    await pool.query("select 1");
    const resume = once(process, "message");
    process.send({ type: "prepared", pid: process.pid });
    const [call] = await resume;
    input.callId = call.callId;
  }
  if (input.checkpoint) {
    const command = async (text) =>
      (
        await sendFreeSwitchApiCommand(
          {
            FREESWITCH_ESL_HOST: input.esl.host,
            FREESWITCH_ESL_PORT: input.esl.port,
            FREESWITCH_ESL_PASSWORD: input.esl.password
          },
          text,
          1000
        )
      ).body.trim();
    await createInboundQueueCoordinator(
      pool,
      input.socket,
      command,
      executor,
      { ...input.esl, fenced: true },
      async (point, uuid) => {
        if (point === input.checkpoint && uuid === input.callId) {
          process.send({ type: "checkpoint", point });
          await new Promise(() => {});
        }
      }
    ).reconcile();
    throw new Error("Required crash checkpoint not reached");
  }
  if (input.stopBefore) {
    const run = executor.run.bind(executor);
    executor.run = async (id, ...args) => {
      const op = (await pool.query("select request from call_operations where id=$1", [id])).rows[0];
      if (op?.request.transferAction === input.stopBefore) {
        process.send({ type: "checkpoint", point: input.stopBefore });
        await new Promise(() => {});
      }
      return run(id, ...args);
    };
  }
  const recovery = lifecycleRecoveryRuntime(pool, executor, input.socket, input.esl, input.forwarding);
  const logger = {
    info(value, message) {
      if (message === "FreeSWITCH event listener subscribed")
        process.send?.({ type: "subscribed", pid: process.pid });
    },
    warn(value, message) {
      console.error(message, JSON.stringify(value));
    },
    error(value, message) {
      console.error(message, JSON.stringify(value));
    }
  };
  const stop = startFreeSwitchEventListener(
    {
      FREESWITCH_ESL_ENABLED: true,
      FREESWITCH_ESL_HOST: input.esl.host,
      FREESWITCH_ESL_PORT: input.esl.port,
      FREESWITCH_ESL_PASSWORD: input.esl.password,
      FREESWITCH_ESL_EVENT_QUEUE_MAX_SIZE: 4096,
      FREESWITCH_ESL_EVENT_RETRY_INITIAL_MS: 10,
      FREESWITCH_ESL_EVENT_RETRY_MAX_MS: 100,
      FREESWITCH_ESL_RECONCILE_INTERVAL_SECONDS: 1
    },
    pool,
    logger,
    {
      async reconcile(barrier) {
        const result = await recovery.reconcile(barrier);
        for (const call of result.calls)
          if (call.error) console.error("H01 recovery call failed", JSON.stringify(call));
        process.send?.({ type: "pass", status: result.status, calls: result.calls });
        return result;
      }
    }
  );
  process.once("SIGTERM", async () => {
    stop();
    await executor.close();
    await pool.end();
    process.exit(0);
  });
});
