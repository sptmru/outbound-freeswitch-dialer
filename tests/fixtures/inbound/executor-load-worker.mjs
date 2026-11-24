import { CallExecutor } from "../../../apps/api/dist-test/call-executor.js";
import { createCallControlPools } from "../../../apps/api/dist-test/call-control-pools.js";
import { withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
const config = JSON.parse(process.env.INBOUND_FIXTURE_WORKER_CONFIG);
let resume;
process.on("message", () => resume?.());
const wait = () =>
  new Promise((r) => {
    resume = r;
  });
let executor, pools;
try {
  if (config.operations) {
    executor = await CallExecutor.create(config.database, config.replica);
    let holding = 0;
    const release = wait();
    const running = config.operations.map((op, n) =>
      executor.run(op, n === 3 ? "critical" : "normal", {
        async send() {
          if (++holding === 4) process.send({ type: "holding", pid: process.pid, stats: executor.stats });
          await release;
          return {
            state: "succeeded",
            result: { simulated: true },
            evidence: "process barrier released simulated ESL"
          };
        },
        reconcile: async () => null
      })
    );
    const results = await Promise.all(running);
    process.send({ type: "done", results, stats: executor.stats });
  } else {
    pools = await createCallControlPools(config.pools, config.executorUser);
    process.send({ type: "ready", pid: process.pid });
    await wait();
    const samples = {};
    await Promise.all(
      Object.entries(config.pools).map(async ([lane]) => {
        samples[lane] = [];
        const began = performance.now();
        for (let n = 0; n < 120; n++) {
          const offered = began + n * 25;
          await new Promise((r) => setTimeout(r, Math.max(0, offered - performance.now())));
          const c = await pools[lane].connect();
          try {
            if (lane === "admission")
              await withCallAdmission(c, {}, (a) =>
                a.client.query("insert into c03_control_ledger(replica,lane,sequence) values($1,$2,$3)", [
                  config.replica,
                  lane,
                  n
                ])
              );
            else {
              await c.query("begin");
              if (lane === "heartbeat")
                await c.query(
                  "update agent_desk_sessions set expires_at=clock_timestamp()+interval '20 seconds' where id=$1",
                  [config.deskId]
                );
              if (lane === "events")
                await c.query(
                  "insert into call_events(call_id,event_type,raw_json) values($1,'c03_simulated_hangup',$2)",
                  [config.callId, { replica: config.replica, sequence: n }]
                );
              if (lane === "recovery")
                await c.query("select id from call_operations where resolved_at is null limit 8");
              await c.query("insert into c03_control_ledger(replica,lane,sequence) values($1,$2,$3)", [
                config.replica,
                lane,
                n
              ]);
              await c.query("commit");
            }
          } finally {
            c.release();
          }
          samples[lane].push(performance.now() - offered);
        }
      })
    );
    process.send({
      type: "done",
      samples,
      stats: Object.fromEntries(
        Object.keys(config.pools).map((l) => [
          l,
          { total: pools[l].totalCount, waiters: pools[l].waitingCount }
        ])
      )
    });
  }
} catch (e) {
  process.send({ type: "failure", message: e.message, stack: e.stack });
} finally {
  await executor?.close();
  await pools?.close();
  process.disconnect();
}
