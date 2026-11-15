import pg from "pg";
import { ExecutionError } from "./call-executor.js";

// A06: two API replicas, max 4/1/2/1 each; physically isolated from execution.
const partitions = { admission: 4, heartbeat: 1, events: 2, recovery: 1 } as const;
export type ControlLane = keyof typeof partitions;
export async function createCallControlPools(
  configs: Record<ControlLane, pg.PoolConfig>,
  executorUser: string
) {
  const pools = {} as Record<ControlLane, pg.Pool>;
  const roles = new Set([executorUser]);
  try {
    for (const lane of Object.keys(partitions) as ControlLane[]) {
      const max = partitions[lane];
      const pool = new pg.Pool({
        ...configs[lane],
        max,
        connectionTimeoutMillis: 250,
        statement_timeout: 500,
        lock_timeout: 250,
        idle_in_transaction_session_timeout: 1000,
        options: `${configs[lane].options ?? ""} -c statement_timeout=500 -c lock_timeout=250 -c idle_in_transaction_session_timeout=1000`
      });
      pools[lane] = pool;
      pool.on("error", () => {});
      const role = (
        await pool.query(
          "select current_user as name,rolsuper,rolconnlimit from pg_roles where rolname=current_user"
        )
      ).rows[0];
      if (role.rolsuper || role.rolconnlimit !== 2 * max || roles.has(role.name))
        throw new ExecutionError("invalid_control_pool_partition");
      roles.add(role.name);
    }
    return { ...pools, close: () => Promise.all(Object.values(pools).map((p) => p.end())) };
  } catch (error) {
    await Promise.all(Object.values(pools).map((p) => p.end()));
    throw error;
  }
}
