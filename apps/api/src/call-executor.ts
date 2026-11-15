import { randomUUID } from "node:crypto";
import pg from "pg";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";

export const EXECUTION_LOCK_NAMESPACE = 72_203;
export const EXECUTOR_SEAT_NAMESPACE = 72_204;
export class ExecutionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export interface CommandIntent {
  id: string;
  callId: string;
  scope: string;
  key: string;
  fingerprint: string;
  kind: "originate" | "bridge" | "rebridge" | "play_audio" | "hangup" | "release_agent" | "forward_external";
  generation: string;
  commandUuid: string;
  targetUuid: string | null;
  request: Record<string, unknown>;
  deadline: Date;
}
export interface DurableCommand {
  id: string;
  call_id: string;
  command_kind: CommandIntent["kind"];
  generation: string;
  command_uuid: string;
  target_uuid: string | null;
  request: Record<string, unknown>;
  state: string;
  deadline_at: Date;
  result: Record<string, unknown> | null;
}
const critical = (kind: string) => kind === "hangup" || kind === "release_agent";

/** SQL-only, inside common admission; call/slot/capacity/intent commit together.
 * Replay returns persisted identity, and NEVER grants permission to send.
 */
export async function enqueueCallCommand(admission: CallAdmission, input: CommandIntent) {
  admission.assertExecutionCall(input.callId);
  const db = admission.client;
  const existing = await db.query(
    "select * from call_operations where idempotency_scope=$1 and idempotency_key=$2",
    [input.scope, input.key]
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (
      row.call_id !== input.callId ||
      row.request_fingerprint !== input.fingerprint ||
      row.command_kind !== input.kind
    )
      throw new ExecutionError("idempotency_conflict");
    return { operation: row as DurableCommand, replayed: true };
  }
  const count = await db.query(
    `select count(*)::int as total,
      count(*) filter(where command_kind not in ('hangup','release_agent'))::int as normal
     from call_operations where state='pending'`
  );
  if (
    count.rows[0].total >= 64 ||
    (!critical(input.kind) && count.rows[0].normal >= 48) ||
    (critical(input.kind) && count.rows[0].total - count.rows[0].normal >= 16)
  )
    throw new ExecutionError("execution_backlog_full");
  await db.query("insert into call_execution_keys(call_id) values($1) on conflict do nothing", [
    input.callId
  ]);
  const inserted = await db.query(
    `insert into call_operations(id,call_id,idempotency_scope,idempotency_key,request_fingerprint,
      command_kind,generation,command_uuid,target_uuid,request,deadline_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [
      input.id,
      input.callId,
      input.scope,
      input.key,
      input.fingerprint,
      input.kind,
      input.generation,
      input.commandUuid,
      input.targetUuid,
      input.request,
      input.deadline
    ]
  );
  return { operation: inserted.rows[0] as DurableCommand, replayed: false };
}

export interface CommandResolution {
  state: "succeeded" | "failed" | "canceled";
  result: Record<string, unknown>;
  evidence: string;
}
/** Trusted server-side adapter, never an HTTP payload. An ACK alone must return null.
 * Reconciliation must independently establish sender/transport quiescence and exact
 * job/channel evidence (A05). Missing evidence returns null, even after deadline.
 * Adapters must obey signal, use a total transport deadline and close on abort.
 */
export interface CommandDriver {
  // SQL-only action-specific generation/slot/endpoint validation, under admission.
  // Integrating call paths must supply their full token checks here (C04-C07/D-G).
  validate?(operation: DurableCommand, admission: CallAdmission): Promise<boolean>;
  send(
    operation: DurableCommand,
    signal: AbortSignal,
    client: pg.PoolClient
  ): Promise<CommandResolution | null>;
  reconcile(
    operation: DurableCommand,
    signal: AbortSignal,
    client: pg.PoolClient
  ): Promise<CommandResolution | null>;
}
export type ExecutionResult =
  { status: "deferred"; reason: string } | { status: "uncertain" | "terminal"; operation: DurableCommand };

/** Separate pool per worker, 3 ordinary + 1 critical seats; 2 fixed replica IDs.
 * PostgreSQL seat locks fence accidental duplicate replica processes. The login's
 * CONNECTION LIMIT 8 is the physical backstop; it must not serve other workloads.
 * This factory is intentionally not wired into legacy call routes (C04-C07).
 */
export class CallExecutor {
  private readonly occupied = new Set<number>();
  private closed = false;
  private constructor(
    private readonly pool: pg.Pool,
    readonly replica: number
  ) {}
  static async create(config: pg.PoolConfig, replica: number) {
    if (replica !== 0 && replica !== 1) throw new ExecutionError("invalid_executor_replica");
    const pool = new pg.Pool({
      ...config,
      max: 4,
      connectionTimeoutMillis: 250,
      statement_timeout: 500,
      lock_timeout: 250,
      idle_in_transaction_session_timeout: 1000,
      options: `${config.options ?? ""} -c statement_timeout=500 -c lock_timeout=250 -c idle_in_transaction_session_timeout=1000`
    });
    pool.on("error", () => {
      /* Leased clients latch their own error; idle clients are removed by pg. */
    });
    try {
      const r = (await pool.query("select rolsuper,rolconnlimit from pg_roles where rolname=current_user"))
        .rows[0];
      if (r.rolsuper || r.rolconnlimit < 1 || r.rolconnlimit > 8)
        throw new ExecutionError("executor_role_requires_connection_limit");
      return new CallExecutor(pool, replica);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  get stats() {
    return {
      running: this.occupied.size,
      connections: this.pool.totalCount,
      waiters: this.pool.waitingCount
    };
  }
  async close() {
    this.closed = true;
    await this.pool.end();
  }

  async run(
    operationId: string,
    priority: "normal" | "critical",
    driver: CommandDriver
  ): Promise<ExecutionResult> {
    if (this.closed) throw new ExecutionError("executor_closed");
    const seat = (priority === "critical" ? [3] : [0, 1, 2]).find((n) => !this.occupied.has(n));
    if (seat === undefined) return { status: "deferred", reason: "executor_saturated" };
    this.occupied.add(seat); // Before any connection acquisition; no per-backlog waiters.
    let client: pg.PoolClient | undefined;
    let lost = false;
    let locked = false;
    let seatLocked = false;
    let key: number | undefined;
    const controller = new AbortController();
    const latch = () => {
      lost = true;
      controller.abort();
    };
    const owner = randomUUID();
    try {
      try {
        client = await this.pool.connect();
      } catch {
        return { status: "deferred", reason: "execution_acquisition_timeout" };
      }
      client.on("error", latch);
      client.on("end", latch);
      seatLocked = (
        await client.query("select pg_try_advisory_lock($1,$2) as ok", [
          EXECUTOR_SEAT_NAMESPACE,
          this.replica * 4 + seat
        ])
      ).rows[0].ok;
      if (!seatLocked) return { status: "deferred", reason: "executor_replica_occupied" };
      const lookup = await client.query(
        `select k.lock_key from call_operations o join call_execution_keys k on k.call_id=o.call_id where o.id=$1`,
        [operationId]
      );
      if (!lookup.rowCount) throw new ExecutionError("operation_not_enqueued");
      key = lookup.rows[0].lock_key;
      locked = (
        await client.query("select pg_try_advisory_lock($1,$2) as ok", [EXECUTION_LOCK_NAMESPACE, key])
      ).rows[0].ok;
      if (!locked) return { status: "deferred", reason: "call_execution_busy" };
      let op = (await client.query("select * from call_operations where id=$1", [operationId]))
        .rows[0] as DurableCommand;
      if (["succeeded", "failed", "canceled"].includes(op.state))
        return { status: "terminal", operation: op };
      // Call-level uncertainty blocks later side effects, including critical cleanup.
      // H01 may reconcile the original first; a hangup cannot erase a delayed originate.
      const preceding = await client.query(
        "select 1 from call_operations where call_id=$1 and id<>$2 and state in ('executing','uncertain') limit 1",
        [op.call_id, op.id]
      );
      if (preceding.rowCount) return { status: "deferred", reason: "call_outcome_uncertain" };
      if (priority === "critical" && !critical(op.command_kind) && op.state === "pending")
        return { status: "deferred", reason: "critical_reserve" };
      let resolution: CommandResolution | null = null;
      if (op.state === "pending") {
        if (op.request.dependsOn) {
          const parent = (
            await client.query("select state from call_operations where id=$1 and call_id=$2", [
              op.request.dependsOn,
              op.call_id
            ])
          ).rows[0];
          if (parent?.state !== "succeeded")
            return { status: "deferred", reason: "predecessor_not_succeeded" };
        }
        const claimed = await withCallAdmission(client, { callIds: [op.call_id] }, async (admission) => {
          const current = (
            await admission.client.query(
              "select *,deadline_at<=clock_timestamp() as expired from call_operations where id=$1 for update",
              [op.id]
            )
          ).rows[0];
          if (current.state !== "pending") return false;
          const call = (await admission.client.query("select ended_at from calls where id=$1", [op.call_id]))
            .rows[0];
          const invalid =
            (!critical(op.command_kind) && Boolean(call.ended_at)) ||
            (driver.validate && !(await driver.validate(op, admission)));
          if (current.expired || invalid) {
            await admission.client.query(
              "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence=$2 where id=$1",
              [
                op.id,
                current.expired
                  ? "deadline elapsed before any execution attempt"
                  : "execution revalidation refused unstarted command"
              ]
            );
            return false;
          }
          await admission.client.query(
            "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),$3,$4)",
            [op.id, owner, this.replica, seat]
          );
          await admission.client.query("update call_operations set state='uncertain' where id=$1", [op.id]);
          return true;
        });
        op = (await client.query("select * from call_operations where id=$1", [op.id])).rows[0];
        if (!claimed)
          return {
            status: ["succeeded", "failed", "canceled"].includes(op.state) ? "terminal" : "uncertain",
            operation: op
          };
        // Same session, permanent loss latch. Does not pretend to fence DB-to-ESL gap.
        await client.query("select 1");
        if (lost) return { status: "uncertain", operation: op };
        resolution = await this.invoke(driver.send.bind(driver), op, controller, client, false);
      } else {
        resolution = await this.invoke(driver.reconcile.bind(driver), op, controller, client, true);
      }
      if (lost || controller.signal.aborted || !resolution) return { status: "uncertain", operation: op };
      // Same connection, never a second acquisition to save a command result.
      const result = await client.query(
        `update call_operations set state=$2,result=$3,resolution_evidence=$4,resolved_at=clock_timestamp()
         where id=$1 and state in ('executing','uncertain') returning *`,
        [op.id, resolution.state, resolution.result, resolution.evidence]
      );
      return { status: "terminal", operation: result.rows[0] };
    } catch (error) {
      // A connection failure may occur before/after COMMIT. Caller must reread;
      // never downgrade the durable uncertain marker or authorize another send.
      if (lost) return { status: "deferred", reason: "execution_lock_lost" };
      throw error;
    } finally {
      controller.abort();
      if (client) {
        try {
          if (locked && !lost)
            await client.query("select pg_advisory_unlock($1,$2)", [EXECUTION_LOCK_NAMESPACE, key]);
          if (seatLocked && !lost)
            await client.query("select pg_advisory_unlock($1,$2)", [
              EXECUTOR_SEAT_NAMESPACE,
              this.replica * 4 + seat
            ]);
        } catch {
          lost = true;
        }
        client.removeListener("error", latch);
        client.removeListener("end", latch);
        client.release(lost);
      }
      this.occupied.delete(seat);
    }
  }
  private async invoke(
    action: CommandDriver["send"],
    op: DurableCommand,
    controller: AbortController,
    client: pg.PoolClient,
    reconciling: boolean
  ) {
    const remaining = (
      await client.query(
        "select greatest(0,least(5000,extract(epoch from (deadline_at-clock_timestamp()))*1000))::int as ms from call_operations where id=$1",
        [op.id]
      )
    ).rows[0].ms;
    // Reconciliation still inspects expired work; expiry cannot resolve uncertainty.
    if (!reconciling && remaining <= 0) {
      controller.abort();
      return null;
    }
    const ms = reconciling ? 5000 : remaining;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => (controller.signal.aborted ? null : action(op, controller.signal, client)))
          .catch(() => null),
        new Promise<null>((resolve) => {
          abort = () => resolve(null);
          controller.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, ms);
          if (controller.signal.aborted) resolve(null);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) controller.signal.removeEventListener("abort", abort);
    }
  }
}
