import type pg from "pg";
import type { CallExecutor, DurableCommand } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { ingressUuid } from "./ingress-journal.js";

export async function persistRecoveryCleanupJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!ingressUuid.test(job.jobUuid)) return false;
  const op = (
    await db.query(
      "select id,call_id from call_operations where command_uuid=$1 and request->>'h01Cleanup'='true'",
      [job.jobUuid]
    )
  ).rows[0];
  if (!op) return false;
  await db.query(
    "insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json) values($1,'recovery_cleanup_job','BACKGROUND_JOB',$2,$3) on conflict do nothing",
    [
      op.call_id,
      job.headers["event-uuid"] ?? null,
      {
        operationId: op.id,
        jobUuid: job.jobUuid,
        body: job.body,
        source: job.headers["recovery-source"] ?? "esl"
      }
    ]
  );
  return true;
}
export function recoveryCleanupExecutor(
  pool: pg.Pool,
  executor: CallExecutor,
  esl: { host: string; port: number; password: string; fenced?: boolean },
  command: (text: string) => Promise<string>
) {
  async function resolution(op: DurableCommand, db: pg.PoolClient) {
    const job = (
      await db.query(
        "select 1 from call_events where call_id=$1 and event_type='recovery_cleanup_job' and raw_json->>'jobUuid'=$2",
        [op.call_id, op.command_uuid]
      )
    ).rowCount;
    if (!job || (await command(`uuid_exists ${op.target_uuid}`)).trim() !== "false") return null;
    return {
      state: "succeeded" as const,
      result: { jobUuid: op.command_uuid },
      evidence: "fixed cleanup sender complete and exact UUID absent; H01 persists concrete leg cleanup"
    };
  }
  const driver = createCommandDriver({
    ...esl,
    buildCommand(op) {
      if (!ingressUuid.test(op.target_uuid ?? "")) throw new Error("Invalid recovery cleanup UUID");
      return `uuid_kill ${op.target_uuid} NORMAL_CLEARING`;
    },
    async validate(op, a) {
      return Boolean(
        (
          await a.client.query(
            `select 1 from call_legs l join calls c on c.id=l.call_id where l.id::text=$1 and l.participant_id::text=$2 and l.freeswitch_uuid=$3 and c.id=$4 and c.ended_at is not null`,
            [op.request.legId, op.request.participantId, op.target_uuid, op.call_id]
          )
        ).rowCount
      );
    },
    async verify(op, job, _signal, db) {
      await persistRecoveryCleanupJob(db, job);
      return resolution(op, db);
    },
    async reconcile(op, _signal, db) {
      return resolution(op, db);
    }
  });
  return {
    async reconcile(callId: string) {
      for (const op of (
        await pool.query(
          "select id from call_operations where call_id=$1 and request->>'h01Cleanup'='true' and resolved_at is null order by created_at,id limit 8",
          [callId]
        )
      ).rows)
        await executor.run(op.id, "critical", driver);
    }
  };
}
