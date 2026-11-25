import { CallExecutor } from "./call-executor.js";
import {
  checkCoordinationConfiguration,
  checkCoordinationDependencies
} from "./call-coordination-runtime.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import {
  checkCutoverDatabase,
  checkCutoverJournal,
  checkCutoverSwitch,
  finishCallCoordinationCutover
} from "./coordination-cutover.js";

const config = loadConfig();
const pool = createPool(config);
try {
  const [action, previousCore] = process.argv.slice(2);
  if (!["inspect", "activate", "deactivate", "check-drained", "check-feature-off"].includes(action ?? ""))
    throw new Error("Invalid call coordination cutover action");
  await checkCutoverDatabase(pool);
  const core = await checkCutoverSwitch(config);
  if (action === "inspect") {
    await checkCoordinationConfiguration(pool, config);
    const executor = await CallExecutor.create({ connectionString: config.CALL_EXECUTOR_DATABASE_URL }, 0);
    await executor.close();
    console.log(core);
  } else if (action !== "check-feature-off") {
    await checkCutoverJournal(config);
    if (action === "activate") {
      if (!previousCore || core === previousCore)
        throw new Error("Stop legacy senders and start a new FreeSWITCH incarnation before cutover");
      await checkCoordinationDependencies(pool, config);
      const executor = await CallExecutor.create({ connectionString: config.CALL_EXECUTOR_DATABASE_URL }, 0);
      await executor.close();
      await finishCallCoordinationCutover(pool, true);
    } else if (action === "deactivate") {
      await finishCallCoordinationCutover(pool, false);
    }
    console.log("Call coordination cutover checks passed");
  }
} catch (error) {
  // Configuration may contain a connection URI. Do not log driver details or SQL.
  if (
    error instanceof Error &&
    /^(Call coordination|Call admission|Stop legacy|Ingress journal|FreeSWITCH native)/.test(error.message)
  )
    console.error(error.message);
  else
    console.error("Call coordination cutover could not verify PostgreSQL, FreeSWITCH or the ingress journal");
  process.exitCode = 1;
} finally {
  await pool.end();
}
