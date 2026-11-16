// Disposable FS test worker: IPC checkpoints let the parent SIGKILL this actual
// importer process at PostgreSQL transaction boundaries. No app env is loaded.
import pg from "pg";
import { reconcileIngress } from "../apps/api/dist-test/inbound-ingress.js";
import { sendFreeSwitchApiCommand } from "../apps/api/dist-test/esl.js";
process.once("message", async ({ database, socket, config, failAt }) => {
  const pool = new pg.Pool(database);
  try {
    await reconcileIngress(
      pool,
      socket,
      async (cmd) => (await sendFreeSwitchApiCommand(config, cmd)).body.trim(),
      async (point) => {
        if (point === failAt) {
          process.send({ point });
          await new Promise(() => {});
        }
      }
    );
    process.send({ error: "Checkpoint was not reached" });
  } catch {
    process.send({ error: "Importer failed before requested checkpoint" });
  } finally {
    await pool.end();
    process.disconnect();
  }
});
