import { fork } from "node:child_process";
import { once } from "node:events";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "./a05-media.mjs";

export async function createControlPressure(pool, database, directory) {
  const limits = { admission: 8, heartbeat: 2, events: 4, recovery: 2 };
  await pool.query(`create table i03_control_progress(
    replica integer not null, lane text not null, sequence integer not null,
    primary key(replica,lane,sequence))`);
  const configs = {};
  for (const [lane, limit] of Object.entries(limits)) {
    const user = `i03_${lane}`;
    await pool.query(`create role ${user} login connection limit ${limit};
      grant usage on schema public to ${user};
      grant select,insert,update,delete on all tables in schema public to ${user};
      grant usage,select on all sequences in schema public to ${user}`);
    configs[lane] = { ...database, user };
  }
  const log = await open(join(directory, "i03-control-pressure.log"), "a");
  const children = [];
  const result = join(directory, "i03-control-pressure.json");
  const rows = [];
  async function close() {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await log.close();
  }
  try {
    for (let replica = 0; replica < 2; replica++) {
      const child = fork(new URL("./i03-control-pressure-worker.mjs", import.meta.url), [], {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", log.fd, log.fd, "ipc"]
      });
      children.push(child);
      const data = {};
      rows.push(data);
      child.on("message", (message) => {
        data[message.type] = message;
      });
      child.on("error", (error) => {
        data.error = error.message;
      });
      child.send({ configs, replica });
    }
    const checkpoints = (type) =>
      until(
        () => {
          for (const [index, child] of children.entries()) {
            if (
              rows[index].error ||
              (!rows[index][type] && (child.exitCode !== null || child.signalCode !== null))
            )
              throw new Error(`I03 control replica ${index} stopped before ${type}`);
          }
          return rows.every((row) => row[type]);
        },
        `I03 control replicas ${type}`,
        10000
      );
    await checkpoints("ready");
    return {
      async run() {
        for (const child of children) child.send({ type: "start" });
        await checkpoints("done");
        const replicas = rows.map((row) => row.done);
        const progress = await pool.query(
          "select replica,lane,count(*)::int as n from i03_control_progress group by replica,lane order by replica,lane"
        );
        const complete = progress.rows.length === 8 && progress.rows.every(({ n }) => n === 120);
        const lanes = replicas.flatMap(({ progress }) => progress);
        const status =
          complete &&
          lanes.every(
            (lane) =>
              lane.result.status === "passed" && lane.acquired.status === "passed" && lane.pool.waiters === 0
          )
            ? "passed"
            : "failed";
        await writeFile(
          result,
          JSON.stringify(
            {
              status,
              replicas,
              durable: progress.rows,
              boundary:
                "Two OS processes use the product role-separated pools and admission lock. Other lanes write representative SQL, while actual C03 FreeSWITCH transports remain held."
            },
            null,
            2
          ) + "\n"
        );
        return { status, result, committed: progress.rows.reduce((total, { n }) => total + n, 0) };
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
